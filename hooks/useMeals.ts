"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { DailyMealLog, MealType } from "@/types";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import { doc, onSnapshot, setDoc, getDoc, getDocFromServer } from "firebase/firestore";
import { getTodayDateString, formatTime, getDefaultDailyMealLog } from "@/lib/utils";
import { getCachedMealLog, setCachedMealLog } from "@/lib/storage";

export function useMeals(householdId: string | null, feederName: string) {
  const [todayDateString, setTodayDateString] = useState<string>(getTodayDateString());
  
  // Instantaneous 0-delay initial render from synchronous persistent cache
  const [dailyLog, setDailyLog] = useState<DailyMealLog>(() => {
    const today = getTodayDateString();
    if (householdId) {
      const cached = getCachedMealLog(householdId, today);
      if (cached) return cached;
    }
    return getDefaultDailyMealLog(today);
  });

  const [isSyncing, setIsSyncing] = useState<boolean>(true);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  // Check midnight date rollover every minute
  useEffect(() => {
    const interval = setInterval(() => {
      const current = getTodayDateString();
      if (current !== todayDateString) {
        setTodayDateString(current);
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [todayDateString]);

  // Real-time Firestore or Local synchronization
  useEffect(() => {
    if (!householdId) {
      setDailyLog(getDefaultDailyMealLog(todayDateString));
      setIsSyncing(false);
      return;
    }

    // Immediately load from synchronous local cache if available (0ms)
    const cached = getCachedMealLog(householdId, todayDateString);
    if (cached) {
      setDailyLog(cached);
    }

    setIsSyncing(true);

    if (isFirebaseConfigured && db) {
      const logRef = doc(db, "households", householdId, "logs", todayDateString);
      const unsubscribe = onSnapshot(
        logRef,
        (docSnap) => {
          if (docSnap.exists()) {
            const data = docSnap.data() as DailyMealLog;
            setDailyLog(data);
            setCachedMealLog(householdId, todayDateString, data);
            setLastSyncedAt(Date.now());
          } else {
            // New day or first time today: initialize default clean log
            const defaultLog = getDefaultDailyMealLog(todayDateString);
            setDailyLog(defaultLog);
            setCachedMealLog(householdId, todayDateString, defaultLog);
            setLastSyncedAt(Date.now());
          }
          setIsSyncing(false);
        },
        (error) => {
          console.error("Error subscribing to daily meal logs:", error);
          setIsSyncing(false);
        }
      );

      return () => unsubscribe();
    } else {
      // Local demo mode
      const storageKey = `feedy_log_${householdId}_${todayDateString}`;

      const loadFromStorage = () => {
        try {
          const raw = localStorage.getItem(storageKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            setDailyLog(parsed);
            setCachedMealLog(householdId, todayDateString, parsed);
          } else {
            const defaultLog = getDefaultDailyMealLog(todayDateString);
            setDailyLog(defaultLog);
            setCachedMealLog(householdId, todayDateString, defaultLog);
          }
          setLastSyncedAt(Date.now());
        } catch (e) {
          console.error(e);
        }
        setIsSyncing(false);
      };

      loadFromStorage();

      let channel: BroadcastChannel | null = null;
      if (typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel("feedy_sync");
        channel.onmessage = (event) => {
          if (event.data?.type === "MEAL_UPDATE" && event.data?.householdId === householdId) {
            loadFromStorage();
          }
        };
      }

      return () => {
        channel?.close();
      };
    }
  }, [householdId, todayDateString]);

  // Direct server fetch on wake-up / foreground / manual refresh to bypass stale background sockets
  const fetchFreshMealLog = useCallback(async () => {
    if (!householdId) return;

    const currentToday = getTodayDateString();
    setTodayDateString(currentToday);
    setIsSyncing(true);

    if (isFirebaseConfigured && db) {
      try {
        const logRef = doc(db, "households", householdId, "logs", currentToday);
        let docSnap;
        try {
          // 2.5s race timeout so slow cellular networks don't hang the sync indicator
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Server fetch timeout")), 2500)
          );
          docSnap = await Promise.race([getDocFromServer(logRef), timeoutPromise]);
        } catch {
          docSnap = await getDoc(logRef);
        }

        if (docSnap && docSnap.exists()) {
          const freshData = docSnap.data() as DailyMealLog;
          setDailyLog(freshData);
          setCachedMealLog(householdId, currentToday, freshData);
        } else if (docSnap && !docSnap.exists()) {
          const defaultLog = getDefaultDailyMealLog(currentToday);
          setDailyLog(defaultLog);
          setCachedMealLog(householdId, currentToday, defaultLog);
        }
        setLastSyncedAt(Date.now());
      } catch (err) {
        console.warn("Failed to wake-up fetch meal log:", err);
      } finally {
        setIsSyncing(false);
      }
    } else {
      const cached = getCachedMealLog(householdId, currentToday);
      if (cached) setDailyLog(cached);
      setLastSyncedAt(Date.now());
      setIsSyncing(false);
    }
  }, [householdId]);

  // Listen for window foreground, focus, pageshow, and Service Worker notification clicks
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleWakeUp = () => {
      fetchFreshMealLog();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchFreshMealLog();
      }
    };

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === "NOTIFICATION_CLICKED") {
        const payload = event.data.payload;
        // 1. Instant optimistic update if mealType is included in push data
        if (
          payload?.mealType &&
          (payload.mealType === "breakfast" ||
            payload.mealType === "lunch" ||
            payload.mealType === "dinner")
        ) {
          const mType = payload.mealType as MealType;
          setDailyLog((prev) => {
            const updated = {
              ...prev,
              [mType]: {
                completed: true,
                fedBy: payload.fedBy || prev[mType]?.fedBy || "Roommate",
                fedAt: payload.time || prev[mType]?.fedAt || formatTime(),
              },
            };
            if (householdId) {
              setCachedMealLog(householdId, todayDateString, updated);
            }
            return updated;
          });
        }
        // 2. Fetch fresh document from Firestore server
        fetchFreshMealLog();
      }
    };

    window.addEventListener("focus", handleWakeUp);
    window.addEventListener("pageshow", handleWakeUp);
    window.addEventListener("online", handleWakeUp);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // 30s heartbeat: quietly verify fresh data while app is kept open on screen
    const heartbeat = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        fetchFreshMealLog();
      }
    }, 30000);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    }

    return () => {
      window.removeEventListener("focus", handleWakeUp);
      window.removeEventListener("pageshow", handleWakeUp);
      window.removeEventListener("online", handleWakeUp);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearInterval(heartbeat);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
      }
    };
  }, [fetchFreshMealLog, householdId, todayDateString]);

  // Persist updated meal log
  const saveMealLog = useCallback(
    async (updatedLog: DailyMealLog) => {
      if (!householdId) return;

      // 1. Instant local state update
      setDailyLog(updatedLog);

      // 2. Instant synchronous persistent storage update (survives app kill / restart)
      setCachedMealLog(householdId, todayDateString, updatedLog);
      setLastSyncedAt(Date.now());

      if (isFirebaseConfigured && db) {
        try {
          const logRef = doc(db, "households", householdId, "logs", todayDateString);
          await setDoc(logRef, { ...updatedLog, updatedAt: Date.now() }, { merge: true });
        } catch (err) {
          console.error("Failed to save meal log to Firestore:", err);
        }
      }

      // Multi-tab broadcast
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("feedy_sync");
        channel.postMessage({ type: "MEAL_UPDATE", householdId });
        channel.close();
      }
    },
    [householdId, todayDateString]
  );

  // Feed a specific meal
  const feedMeal = useCallback(
    async (mealType: MealType, customFeeder?: string, petName?: string) => {
      const who = (customFeeder || feederName || "Roommate").trim();
      const timeStr = formatTime();

      const updated: DailyMealLog = {
        ...dailyLog,
        [mealType]: {
          completed: true,
          fedBy: who,
          fedAt: timeStr,
        },
      };

      await saveMealLog(updated);

      // Trigger background push notifications to all other roommates
      if (householdId) {
        const mealLabels: Record<MealType, string> = {
          breakfast: "Breakfast",
          lunch: "Lunch",
          dinner: "Dinner",
        };
        fetch("/api/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            householdId,
            petName: petName || "your pet",
            mealType,
            mealLabel: mealLabels[mealType],
            fedBy: who,
            time: timeStr,
          }),
        }).catch((err) => console.warn("Failed to dispatch push notification:", err));
      }

      return updated;
    },
    [dailyLog, feederName, householdId, saveMealLog]
  );

  // Undo / toggle feeding state
  const toggleMeal = useCallback(
    async (mealType: MealType) => {
      const current = dailyLog[mealType];
      if (current.completed) {
        // Undo
        const updated: DailyMealLog = {
          ...dailyLog,
          [mealType]: {
            completed: false,
            fedBy: null,
            fedAt: null,
          },
        };
        await saveMealLog(updated);
      } else {
        // Feed
        await feedMeal(mealType);
      }
    },
    [dailyLog, feedMeal, saveMealLog]
  );

  // Reset entire day (useful for testing or mistake resets)
  const resetToday = useCallback(async () => {
    const emptyLog = getDefaultDailyMealLog(todayDateString);
    await saveMealLog(emptyLog);
  }, [saveMealLog, todayDateString]);

  return {
    todayDateString,
    dailyLog,
    isSyncing,
    lastSyncedAt,
    refreshMealLog: fetchFreshMealLog,
    feedMeal,
    toggleMeal,
    resetToday,
  };
}
