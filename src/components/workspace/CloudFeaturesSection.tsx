/**
 * Privacy page: one switch per cloud feature, the last-30-days activity
 * log, consent history, and cleanup of older PRIVATE chats on the server.
 */
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Cloud, Loader, Trash2 } from "lucide-react";
import {
  CLOUD_FEATURES,
  CLOUD_FEATURE_KEYS,
  CLOUD_FEATURE_OFF_DELETES,
  isCloudFeature,
  type CloudFeature,
} from "@/lib/cloud-features";
import {
  getCloudFeatures,
  setCloudFeature,
  getCloudActivity,
  countPrivateServerChats,
  deletePrivateServerChats,
  type CloudFeatureState,
  type CloudActivityDay,
} from "@/lib/cloud-features.functions";
import { CloudFeatureSheet } from "@/components/workspace/CloudFeatureSheet";

type Consent = { feature: string; granted: boolean; wording_version: string; source: string; created_at: string };

const titleOf = (f: string) => (isCloudFeature(f) ? CLOUD_FEATURES[f].title : f);

export function CloudFeaturesSection() {
  const getFn = useServerFn(getCloudFeatures);
  const setFn = useServerFn(setCloudFeature);
  const actFn = useServerFn(getCloudActivity);
  const countFn = useServerFn(countPrivateServerChats);
  const delFn = useServerFn(deletePrivateServerChats);

  const [features, setFeatures] = useState<CloudFeatureState[]>([]);
  const [days, setDays] = useState<CloudActivityDay[]>([]);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [legacy, setLegacy] = useState<{ messages: number; files: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<CloudFeature | null>(null);
  const [confirmOff, setConfirmOff] = useState<CloudFeature | null>(null);
  const [deleteChats, setDeleteChats] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [f, a, c] = await Promise.all([getFn(), actFn(), countFn()]);
      setFeatures(f.features);
      setDays(a.days);
      setConsents(a.consents);
      setLegacy(c);
    } catch {
      setError("Couldn't load your cloud features. Try again in a moment.");
    }
  }, [getFn, actFn, countFn]);
  useEffect(() => { void load(); }, [load]);

  const change = async (feature: CloudFeature, granted: boolean) => {
    setBusy(feature);
    setError(null);
    try {
      const r = await setFn({
        data: { feature, granted, source: "settings", deleteCloudChats: !granted && deleteChats },
      });
      setFeatures(r.features);
      void load();
    } catch {
      setError("That change didn't save. Try again.");
    } finally {
      setBusy(null);
      setAsking(null);
      setConfirmOff(null);
      setDeleteChats(false);
    }
  };

  const visible = CLOUD_FEATURE_KEYS.filter((k) => CLOUD_FEATURES[k].showOnPrivacyPage);

  return (
    <section className="mb-8 rounded-xl border bg-card/40 p-6">
      <div className="mb-2 flex items-center gap-2">
        <Cloud className="h-5 w-5 text-primary" />
        <h2 className="text-xl font-semibold">Cloud features</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Everything starts private. Each switch below sends something off this device only once you turn it on.
      </p>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <ul className="divide-y divide-border">
        {visible.map((k) => {
          const st = features.find((f) => f.feature === k);
          const on = !!st?.on;
          return (
            <li key={k} className="py-4">
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="font-medium">{CLOUD_FEATURES[k].title}</div>
                  <p className="mt-1 text-sm text-muted-foreground">{CLOUD_FEATURES[k].words}</p>
                  {st?.changedAt && (
                    <p className="mt-1 text-xs font-mono text-muted-foreground">
                      {on ? "On" : "Off"} since {new Date(st.changedAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <Switch
                  aria-label={CLOUD_FEATURES[k].title}
                  checked={on}
                  disabled={busy === k}
                  onCheckedChange={(v) => (v ? setAsking(k) : setConfirmOff(k))}
                />
              </div>
              {confirmOff === k && (
                <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                  <p>Turning this off deletes: {CLOUD_FEATURE_OFF_DELETES[k]}</p>
                  {k === "cloud_chat" && (
                    <label className="mt-2 flex items-center gap-2">
                      <input type="checkbox" checked={deleteChats} onChange={(e) => setDeleteChats(e.target.checked)} />
                      Also delete my cloud chats, their messages and photos
                    </label>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="destructive" disabled={busy === k} onClick={() => change(k, false)}>
                      Turn off
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmOff(null)}>
                      Keep on
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <CloudFeatureSheet
        feature={asking}
        open={!!asking}
        busy={!!busy}
        onNotNow={() => setAsking(null)}
        onTurnOn={() => asking && change(asking, true)}
      />

      <h3 className="mt-6 mb-2 font-semibold">What went to the cloud (last 30 days)</h3>
      {days.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing. Everything stayed on this device.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {days.map((d) => (
            <li key={d.day}>
              <span className="font-mono text-muted-foreground">{d.day}</span>{" "}
              {d.entries.map((e) => `${titleOf(e.feature)} via ${e.provider} ×${e.count}`).join(" · ")}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-muted-foreground">Only which feature, which service and when — never what you sent.</p>

      <h3 className="mt-6 mb-2 font-semibold">Your choices</h3>
      {consents.length === 0 ? (
        <p className="text-sm text-muted-foreground">You haven't turned anything on.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {consents.slice(0, 50).map((c, i) => (
            <li key={i}>
              <span className="font-mono text-muted-foreground">{new Date(c.created_at).toLocaleString()}</span>{" "}
              {titleOf(c.feature)} {c.granted ? "turned on" : "turned off"} (wording {c.wording_version}, {c.source})
            </li>
          ))}
        </ul>
      )}

      {legacy && legacy.messages + legacy.files > 0 && (
        <div className="mt-6 rounded-lg border p-4">
          <h3 className="font-semibold">Older PRIVATE chats on our server</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Before PRIVATE became fully on-device, {legacy.messages} message(s) and {legacy.files} file(s) were
            saved on our server. They stay in your export until you delete them.
          </p>
          <Button
            className="mt-3"
            size="sm"
            variant="destructive"
            disabled={busy === "legacy"}
            onClick={async () => {
              setBusy("legacy");
              try {
                await delFn();
                setLegacy(await countFn());
              } catch {
                setError("Couldn't delete them. Try again.");
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "legacy" ? <Loader className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete them
          </Button>
        </div>
      )}
    </section>
  );
}
