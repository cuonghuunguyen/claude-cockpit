import { useEffect, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";

/**
 * Shared settings-store contract with the Rust firing gate
 * (`app/src-tauri/src/daemon_client.rs::notification_enabled`) — one store
 * file, one set of key names (D-06). Keys default to `true` (fire) whenever
 * absent, matching the Rust side's fail-open-to-firing behavior.
 *
 * Deliberately, no persisted key for the permission toggle exists anywhere
 * in this file: the permission toggle below is rendered `disabled` and has
 * no write path at all (NOT-03, Pitfall 2) — this is a structural lock, not
 * just a UI-styled one.
 */
const SETTINGS_STORE_FILE = "settings.json";
const NOTIFY_INPUT_KEY = "notify_input_enabled";
const NOTIFY_DONE_KEY = "notify_done_enabled";

/**
 * Notification preferences panel (NOT-03, D-06).
 *
 * Three toggles, only two of which are actually writable:
 * - "Permission requests" is always checked and rendered `disabled` — it
 *   can never be turned off (NOT-03: permission prompts are never
 *   suppressed).
 * - "Waiting for input" and "Agent finished" are user-toggleable and
 *   persisted via `tauri-plugin-store`'s `settings.json`, surviving an app
 *   restart.
 *
 * Component shape borrowed from `OfflineBanner.tsx` (single exported
 * function, local `useState`, listen/load-on-mount with a `cancelled`
 * guard); each toggle's async write borrows `SessionCard.tsx::handleDismiss`'s
 * try/catch/finally + inline `-error` idiom. Deliberately NOT a single
 * generic `toggle(type)` handler shared across all three — permission is
 * special-cased at the component level so the safety invariant is
 * structural, not incidental (Pitfall 2).
 */
export function NotificationSettings() {
  const [inputEnabled, setInputEnabled] = useState(true);
  const [doneEnabled, setDoneEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let store: Store | undefined;

    async function bootstrap() {
      try {
        store = await load(SETTINGS_STORE_FILE);
        const [input, done] = await Promise.all([
          store.get<boolean>(NOTIFY_INPUT_KEY),
          store.get<boolean>(NOTIFY_DONE_KEY),
        ]);
        if (cancelled) return;
        // Absent key => default true (fire), matching the Rust gate.
        setInputEnabled(input ?? true);
        setDoneEnabled(done ?? true);
      } catch (err) {
        console.error("cockpit: failed to load notification settings", err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(key: string, value: boolean, revert: () => void) {
    setSaveError(null);
    try {
      const store = await load(SETTINGS_STORE_FILE);
      await store.set(key, value);
      await store.save();
    } catch (err) {
      console.error("cockpit: failed to save notification setting", key, err);
      setSaveError("Could not save — try again.");
      revert();
    }
  }

  function handleInputToggle() {
    const next = !inputEnabled;
    setInputEnabled(next);
    persist(NOTIFY_INPUT_KEY, next, () => setInputEnabled(!next));
  }

  function handleDoneToggle() {
    const next = !doneEnabled;
    setDoneEnabled(next);
    persist(NOTIFY_DONE_KEY, next, () => setDoneEnabled(!next));
  }

  return (
    <section className="notification-settings" aria-label="Notification settings">
      <h2 className="notification-settings-title">Notifications</h2>

      <label className="notification-settings-row notification-settings-locked">
        <input type="checkbox" checked disabled />
        Permission requests
        <span className="notification-settings-hint">
          Always on — permission prompts can&rsquo;t be silenced.
        </span>
      </label>

      <label className="notification-settings-row">
        <input
          type="checkbox"
          checked={inputEnabled}
          disabled={!loaded}
          onChange={handleInputToggle}
        />
        Waiting for input
      </label>

      <label className="notification-settings-row">
        <input
          type="checkbox"
          checked={doneEnabled}
          disabled={!loaded}
          onChange={handleDoneToggle}
        />
        Agent finished
      </label>

      {saveError && <div className="notification-settings-error">{saveError}</div>}
    </section>
  );
}
