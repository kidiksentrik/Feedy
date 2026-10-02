"use client";

import { useState, useEffect, useCallback } from "react";
import { Household, RecentHousehold } from "@/types";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import { doc, onSnapshot, setDoc, getDoc, getDocFromServer, updateDoc } from "firebase/firestore";
import { generateJoinCode } from "@/lib/utils";
import {
  getStoredHouseholdId,
  saveStoredHouseholdId,
  clearStoredHouseholdId,
  getStoredFeederName,
  saveStoredFeederName,
  getRecentHouseholds,
  recordRecentHousehold,
  getCachedHousehold,
  setCachedHousehold,
} from "@/lib/storage";

const STORAGE_KEYS = {
  MOCK_HOUSEHOLDS: "nomciu_mock_households",
};

export function useHousehold() {
  const [householdId, setHouseholdId] = useState<string | null>(() => getStoredHouseholdId());
  const [household, setHousehold] = useState<Household | null>(() => getCachedHousehold());
  const [feederName, setFeederName] = useState<string>(() => getStoredFeederName());
  const [recentHouseholds, setRecentHouseholds] = useState<RecentHousehold[]>(() => getRecentHouseholds());
  const [isLoading, setIsLoading] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return !getStoredHouseholdId();
  });
  const [error, setError] = useState<string | null>(null);

  // 1. Initial load of persistent multi-layer storage on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedFeeder = getStoredFeederName();
    const storedHouseholdId = getStoredHouseholdId();
    const recents = getRecentHouseholds();
    const cachedH = getCachedHousehold(storedHouseholdId);

    if (storedFeeder) setFeederName(storedFeeder);
    if (storedHouseholdId) setHouseholdId(storedHouseholdId);
    if (recents.length > 0) setRecentHouseholds(recents);
    if (cachedH) setHousehold(cachedH);

    if (!storedHouseholdId) {
      setIsLoading(false);
    }
  }, []);

  // 2. Reactive listener on householdId
  useEffect(() => {
    if (!householdId) {
      setHousehold(null);
      setIsLoading(false);
      return;
    }

    // Only set full blocking loader if we don't have a cached household in hand
    if (!household) {
      setIsLoading(true);
    }

    // Safety timeout: Ensure app never hangs on loading state indefinitely
    const safetyTimer = setTimeout(() => {
      setIsLoading(false);
    }, 2500);

    if (isFirebaseConfigured && db) {
      const householdRef = doc(db, "households", householdId);
      const unsubscribe = onSnapshot(
        householdRef,
        (docSnap) => {
          clearTimeout(safetyTimer);
          if (docSnap.exists()) {
            const data = docSnap.data() as Household;
            setHousehold(data);
            setCachedHousehold(data);
            saveStoredHouseholdId(data.id);
            recordRecentHousehold({
              id: data.id,
              petName: data.petName,
              petPhotoUrl: data.petPhotoUrl,
            });
            setRecentHouseholds(getRecentHouseholds());
            setError(null);
          } else {
            setError("Household not found.");
            setHousehold(null);
          }
          setIsLoading(false);
        },
        (err) => {
          clearTimeout(safetyTimer);
          console.error("Firestore household subscription error:", err);
          setError("Failed to sync household data.");
          setIsLoading(false);
        }
      );

      return () => {
        clearTimeout(safetyTimer);
        unsubscribe();
      };
    } else {
      // Local demo mode
      const loadMock = () => {
        try {
          const raw = localStorage.getItem(STORAGE_KEYS.MOCK_HOUSEHOLDS);
          const map: Record<string, Household> = raw ? JSON.parse(raw) : {};
          if (map[householdId]) {
            const h = map[householdId];
            setHousehold(h);
            saveStoredHouseholdId(h.id);
            recordRecentHousehold({
              id: h.id,
              petName: h.petName,
              petPhotoUrl: h.petPhotoUrl,
            });
            setRecentHouseholds(getRecentHouseholds());
            setError(null);
          } else {
            setHousehold(null);
          }
        } catch (e) {
          console.error(e);
        }
        setIsLoading(false);
      };

      loadMock();

      let channel: BroadcastChannel | null = null;
      if (typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel("nomciu_sync");
        channel.onmessage = (event) => {
          if (event.data?.type === "HOUSEHOLD_UPDATE") {
            loadMock();
          }
        };
      }

      return () => {
        channel?.close();
      };
    }
  }, [householdId]);

  // Wake-up / foreground refresh for household
  useEffect(() => {
    if (typeof window === "undefined" || !householdId || !isFirebaseConfigured || !db) return;

    const handleWakeUp = async () => {
      if (!db || !householdId) return;
      try {
        const householdRef = doc(db, "households", householdId);
        let docSnap;
        try {
          docSnap = await getDocFromServer(householdRef);
        } catch {
          docSnap = await getDoc(householdRef);
        }
        if (docSnap && docSnap.exists()) {
          const data = docSnap.data() as Household;
          setHousehold(data);
          setCachedHousehold(data);
        }
      } catch (err) {
        console.warn("Failed to wake-up sync household:", err);
      }
    };

    window.addEventListener("focus", handleWakeUp);
    window.addEventListener("pageshow", handleWakeUp);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") handleWakeUp();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleWakeUp);
      window.removeEventListener("pageshow", handleWakeUp);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [householdId]);

  // Save feeder name to multi-layer storage
  const saveFeederName = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    saveStoredFeederName(trimmed);
    setFeederName(trimmed);
  }, []);

  // Create a new household
  const createHousehold = useCallback(
    async (petName: string, petPhotoUrl: string) => {
      setIsLoading(true);
      setError(null);

      const joinCode = generateJoinCode();
      const newHousehold: Household = {
        id: joinCode,
        joinCode: joinCode,
        petName: petName.trim() || "Luna",
        petPhotoUrl:
          petPhotoUrl ||
          "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=400&auto=format&fit=crop&q=80",
        createdAt: Date.now(),
      };

      try {
        if (isFirebaseConfigured && db) {
          await setDoc(doc(db, "households", joinCode), newHousehold);
        } else {
          // Local demo storage
          const raw = localStorage.getItem(STORAGE_KEYS.MOCK_HOUSEHOLDS);
          const map: Record<string, Household> = raw ? JSON.parse(raw) : {};
          map[joinCode] = newHousehold;
          localStorage.setItem(STORAGE_KEYS.MOCK_HOUSEHOLDS, JSON.stringify(map));

          if (typeof BroadcastChannel !== "undefined") {
            const channel = new BroadcastChannel("nomciu_sync");
            channel.postMessage({ type: "HOUSEHOLD_UPDATE" });
            channel.close();
          }
        }

        saveStoredHouseholdId(joinCode);
        recordRecentHousehold({
          id: joinCode,
          petName: newHousehold.petName,
          petPhotoUrl: newHousehold.petPhotoUrl,
        });
        setRecentHouseholds(getRecentHouseholds());
        setHouseholdId(joinCode);
        setHousehold(newHousehold);
        return newHousehold;
      } catch (err: any) {
        console.error("Error creating household:", err);
        setError(err?.message || "Failed to create household.");
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // Join existing household via 6-digit code
  const joinHousehold = useCallback(async (code: string) => {
    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) throw new Error("Please enter a valid code.");

    setIsLoading(true);
    setError(null);

    try {
      if (isFirebaseConfigured && db) {
        const docRef = doc(db, "households", cleanCode);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
          throw new Error("No household found with this code. Please check and try again.");
        }

        const data = docSnap.data() as Household;
        saveStoredHouseholdId(cleanCode);
        recordRecentHousehold({
          id: cleanCode,
          petName: data.petName,
          petPhotoUrl: data.petPhotoUrl,
        });
        setRecentHouseholds(getRecentHouseholds());
        setHouseholdId(cleanCode);
        setHousehold(data);
        return data;
      } else {
        // Local demo mode
        const raw = localStorage.getItem(STORAGE_KEYS.MOCK_HOUSEHOLDS);
        const map: Record<string, Household> = raw ? JSON.parse(raw) : {};
        const found = map[cleanCode];

        if (!found) {
          throw new Error("No household found with this code in local storage. (Try creating one first!)");
        }

        saveStoredHouseholdId(cleanCode);
        recordRecentHousehold({
          id: cleanCode,
          petName: found.petName,
          petPhotoUrl: found.petPhotoUrl,
        });
        setRecentHouseholds(getRecentHouseholds());
        setHouseholdId(cleanCode);
        setHousehold(found);
        return found;
      }
    } catch (err: any) {
      setError(err?.message || "Failed to join household.");
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Switch or leave household
  const leaveHousehold = useCallback(() => {
    clearStoredHouseholdId();
    setHouseholdId(null);
    setHousehold(null);
    setRecentHouseholds(getRecentHouseholds());
  }, []);

  // Update pet profile (photo and/or name)
  const updatePetProfile = useCallback(
    async (newName?: string, newPhotoUrl?: string) => {
      if (!householdId) return;

      try {
        const updates: Partial<Household> = {};
        if (newName !== undefined && newName.trim()) updates.petName = newName.trim();
        if (newPhotoUrl !== undefined && newPhotoUrl.trim()) updates.petPhotoUrl = newPhotoUrl.trim();

        if (Object.keys(updates).length === 0) return;

        if (isFirebaseConfigured && db) {
          const docRef = doc(db, "households", householdId);
          await updateDoc(docRef, updates);
        } else {
          // Local demo mode
          const raw = localStorage.getItem(STORAGE_KEYS.MOCK_HOUSEHOLDS);
          const map: Record<string, Household> = raw ? JSON.parse(raw) : {};
          if (map[householdId]) {
            map[householdId] = { ...map[householdId], ...updates };
            localStorage.setItem(STORAGE_KEYS.MOCK_HOUSEHOLDS, JSON.stringify(map));
            setHousehold(map[householdId]);

            if (typeof BroadcastChannel !== "undefined") {
              const channel = new BroadcastChannel("nomciu_sync");
              channel.postMessage({ type: "HOUSEHOLD_UPDATE" });
              channel.close();
            }
          }
        }

        recordRecentHousehold({
          id: householdId,
          petName: newName?.trim() || household?.petName || "Pet",
          petPhotoUrl: newPhotoUrl?.trim() || household?.petPhotoUrl || "",
        });
        setRecentHouseholds(getRecentHouseholds());
      } catch (err: any) {
        console.error("Error updating pet profile:", err);
        throw err;
      }
    },
    [householdId, household]
  );

  return {
    householdId,
    household,
    feederName,
    recentHouseholds,
    isLoading,
    error,
    saveFeederName,
    createHousehold,
    joinHousehold,
    leaveHousehold,
    updatePetProfile,
    isDemoMode: !isFirebaseConfigured,
  };
}
