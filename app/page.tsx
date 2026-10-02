"use client";

import React, { useState, useEffect, useRef } from "react";
import { Navbar } from "@/components/Navbar";
import { PetHero } from "@/components/PetHero";
import { FeedNowButton } from "@/components/FeedNowButton";
import { MealGrid } from "@/components/MealGrid";
import { OnboardingModal } from "@/components/OnboardingModal";
import { InviteModal } from "@/components/InviteModal";
import { EditPetModal } from "@/components/EditPetModal";
import { NotificationBanner } from "@/components/NotificationBanner";
import { useHousehold } from "@/hooks/useHousehold";
import { useMeals } from "@/hooks/useMeals";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { Loader2 } from "lucide-react";

export default function Home() {
  const {
    householdId,
    household,
    feederName,
    recentHouseholds,
    isLoading: isHouseholdLoading,
    isDemoMode,
    saveFeederName,
    createHousehold,
    joinHousehold,
    leaveHousehold,
    updatePetProfile,
  } = useHousehold();

  // Parallel instant hydration: uses cached householdId immediately without waiting for Firestore household object
  const activeHouseholdId = household?.id || householdId || null;

  const {
    dailyLog,
    isSyncing,
    lastSyncedAt,
    refreshMealLog,
    feedMeal,
    toggleMeal,
    resetToday,
  } = useMeals(activeHouseholdId, feederName);

  const {
    isSupported: isPushSupported,
    permission: pushPermission,
    isSubscribed: isPushSubscribed,
    isSubscribing: isPushSubscribing,
    subscribe: subscribeToPush,
  } = usePushNotifications(household?.id || null, feederName);

  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState<"household" | "feeder">("household");
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [isEditPetOpen, setIsEditPetOpen] = useState(false);

  // Mobile Pull-to-Refresh
  const [pullY, setPullY] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const touchStartY = useRef(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (typeof window !== "undefined" && window.scrollY <= 0) {
      touchStartY.current = e.touches[0].clientY;
      setIsPulling(true);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isPulling || (typeof window !== "undefined" && window.scrollY > 0)) return;
    const currentY = e.touches[0].clientY;
    const diff = currentY - touchStartY.current;
    if (diff > 0) {
      // Damped pull distance
      setPullY(Math.min(diff * 0.45, 75));
    }
  };

  const handleTouchEnd = () => {
    if (pullY > 48) {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        try {
          navigator.vibrate(35);
        } catch (_) {}
      }
      refreshMealLog();
    }
    setPullY(0);
    setIsPulling(false);
  };

  // Check URL query param for automatic join link e.g. /?join=749201
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get("join");

    if (joinCode && (!household || household.joinCode !== joinCode)) {
      joinHousehold(joinCode).catch(() => {
        setIsOnboardingOpen(true);
      });
    }
  }, [household, joinHousehold]);

  // Synchronize modal open state with missing household or feeder nickname
  useEffect(() => {
    if (!isHouseholdLoading) {
      if (!household) {
        setOnboardingStep("household");
        setIsOnboardingOpen(true);
      } else if (!feederName) {
        setOnboardingStep("feeder");
        setIsOnboardingOpen(true);
      } else {
        setIsOnboardingOpen(false);
      }
    }
  }, [household, feederName, isHouseholdLoading]);

  const handleSendTestPush = async () => {
    if (!household) return;
    try {
      const res = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          householdId: household.id,
          petName: household.petName,
          isTest: true,
        }),
      });
      const data = await res.json();
      if (data.sentCount > 0) {
        alert("🔔 Test alert sent! Check your lock screen or notification center.");
      } else {
        alert("Notification dispatched. (If not received, make sure notifications are enabled in your device Settings).");
      }
    } catch (err) {
      alert("Failed to send test push.");
    }
  };

  const handleSwitchHousehold = () => {
    leaveHousehold();
    setOnboardingStep("household");
    setIsOnboardingOpen(true);
  };

  // Loading state
  if (isHouseholdLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[#0D0E13]">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-nomciu-peach to-amber-500 flex items-center justify-center text-3xl shadow-tactile animate-pulse mb-4 select-none">
          🐾
        </div>
        <div className="flex items-center gap-2 text-stone-200 font-black text-sm">
          <Loader2 className="w-4 h-4 animate-spin text-nomciu-peach" />
          <span>Waking up Feedy...</span>
        </div>
      </div>
    );
  }

  return (
    <main
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="min-h-screen flex flex-col justify-between safe-top safe-bottom bg-[#0D0E13] text-stone-100 overflow-x-hidden"
    >
      {/* Mobile Pull-to-Refresh visual indicator */}
      {pullY > 10 && (
        <div
          style={{ height: `${pullY}px` }}
          className="w-full max-w-md mx-auto flex items-center justify-center overflow-hidden transition-all duration-75 text-xs font-bold gap-1.5 pt-1"
        >
          <Loader2
            className={`w-4 h-4 ${
              pullY > 48 ? "animate-spin text-emerald-400" : "text-nomciu-peach"
            }`}
          />
          <span className={pullY > 48 ? "text-emerald-400" : "text-stone-400"}>
            {pullY > 48 ? "Release to sync with server" : "Pull down to refresh"}
          </span>
        </div>
      )}

      {/* Mobile-contained wrapper (Looks like native app on mobile & elegant mobile card on desktop) */}
      <div className="w-full max-w-md mx-auto flex-1 flex flex-col justify-between pb-6 overflow-x-hidden">
        <div>
          {/* Top Bar */}
          <Navbar
            joinCode={household?.joinCode || ""}
            feederName={feederName}
            isDemoMode={isDemoMode}
            isPushSubscribed={isPushSubscribed}
            isSyncing={isSyncing}
            lastSyncedAt={lastSyncedAt}
            onRefresh={refreshMealLog}
            onTogglePush={isPushSubscribed ? undefined : subscribeToPush}
            onSendTestPush={handleSendTestPush}
            onOpenInvite={() => setIsInviteOpen(true)}
            onSwitchHousehold={handleSwitchHousehold}
            onChangeNickname={() => {
              setOnboardingStep("feeder");
              setIsOnboardingOpen(true);
            }}
          />

          {/* Background Push Alerts Banner */}
          {household && (
            <NotificationBanner
              petName={household.petName}
              isSupported={isPushSupported}
              permission={pushPermission}
              isSubscribed={isPushSubscribed}
              isSubscribing={isPushSubscribing}
              onSubscribe={subscribeToPush}
            />
          )}

          {/* Hero Zone: Pet Avatar & Live Emotion Headline */}
          {household && (
            <PetHero
              petName={household.petName}
              petPhotoUrl={household.petPhotoUrl}
              dailyLog={dailyLog}
              onEditPet={() => setIsEditPetOpen(true)}
            />
          )}

          {/* Hero Action: Tactile FEED NOW Button or Completed Status */}
          {household && (
            <FeedNowButton
              dailyLog={dailyLog}
              feederName={feederName}
              onFeed={(type) => feedMeal(type, undefined, household.petName)}
              onUndoMeal={toggleMeal}
            />
          )}

          {/* Daily Meal Tracker: shows today's completed feedings & collapsible full view */}
          {household && (
            <MealGrid
              dailyLog={dailyLog}
              onToggleMeal={toggleMeal}
              onResetToday={resetToday}
            />
          )}
        </div>

        {/* Footer info & Roommate prompt */}
        <footer className="w-full text-center px-4 mt-6">
          <p className="text-[11px] text-stone-400 font-semibold">
            Roommates sync automatically in real-time.
          </p>
          <p className="text-[10px] text-stone-500 font-medium mt-0.5">
            Feedy • Mobile Pet Feeding Tracker
          </p>
        </footer>
      </div>

      {/* Onboarding / Setup Modal */}
      <OnboardingModal
        isOpen={isOnboardingOpen}
        initialStep={onboardingStep}
        feederName={feederName}
        recentHouseholds={recentHouseholds}
        onSaveFeederName={(name) => {
          saveFeederName(name);
          setIsOnboardingOpen(false);
        }}
        onCreateHousehold={createHousehold}
        onJoinHousehold={joinHousehold}
        onClose={() => {
          if (household) {
            setIsOnboardingOpen(false);
          }
        }}
      />

      {/* Invite Roommates Modal */}
      {household && (
        <InviteModal
          isOpen={isInviteOpen}
          onClose={() => setIsInviteOpen(false)}
          householdName={household.petName}
          joinCode={household.joinCode}
        />
      )}

      {/* Edit Pet Profile Modal */}
      {household && (
        <EditPetModal
          isOpen={isEditPetOpen}
          onClose={() => setIsEditPetOpen(false)}
          currentPetName={household.petName}
          currentPetPhotoUrl={household.petPhotoUrl}
          onSave={async (newName, newPhotoUrl) => {
            await updatePetProfile(newName, newPhotoUrl);
          }}
        />
      )}
    </main>
  );
}
