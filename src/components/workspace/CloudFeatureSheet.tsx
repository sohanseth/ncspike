/**
 * Consent sheet for one cloud feature. Bottom sheet on phones, dialog on
 * wider screens. "Turn on" records consent via setCloudFeature; "Not now"
 * records nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { CLOUD_FEATURES, CLOUD_FEATURE_OFF_MESSAGE, type CloudFeature } from "@/lib/cloud-features";
import { getCloudFeatures, setCloudFeature, type CloudFeatureState } from "@/lib/cloud-features.functions";

export const SENSITIVE_LINE =
  "If this includes health or other sensitive details, turning it on is your explicit consent to send them.";
export const OFF_ANYTIME_LINE =
  "You can turn this off any time in Privacy, and turning it off deletes what it stored.";

export function CloudFeatureSheet({
  feature,
  open,
  busy,
  onTurnOn,
  onNotNow,
}: {
  feature: CloudFeature | null;
  open: boolean;
  busy?: boolean;
  onTurnOn: () => void;
  onNotNow: () => void;
}) {
  const isMobile = useIsMobile();
  if (!feature) return null;
  const info = CLOUD_FEATURES[feature];
  const body = (
    <div className="space-y-3 text-sm text-muted-foreground">
      <p className="text-foreground/90 leading-relaxed">{info.words}</p>
      <p>{SENSITIVE_LINE}</p>
      <p>{OFF_ANYTIME_LINE}</p>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onNotNow} disabled={busy}>
          Not now
        </Button>
        <Button onClick={onTurnOn} disabled={busy}>
          Turn on
        </Button>
      </div>
    </div>
  );
  const onOpenChange = (o: boolean) => {
    if (!o) onNotNow();
  };
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          <SheetHeader className="text-left">
            <SheetTitle className="font-display">{info.title}</SheetTitle>
            <SheetDescription className="sr-only">Cloud feature consent</SheetDescription>
          </SheetHeader>
          <div className="mt-3">{body}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">{info.title}</DialogTitle>
          <DialogDescription className="sr-only">Cloud feature consent</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

/** Message + link shown when the server answers cloud_feature_off. */
export function CloudFeatureOffNotice() {
  return (
    <span>
      {CLOUD_FEATURE_OFF_MESSAGE}{" "}
      <Link to="/workspace/privacy" className="underline">
        Open Privacy
      </Link>
    </span>
  );
}

export function isCloudFeatureOffMessage(msg: unknown): boolean {
  return typeof msg === "string" && msg.includes("cloud_feature_off");
}

/**
 * Loads the person's cloud features and offers `ensure(feature)`: resolves
 * true at once when on, otherwise opens the sheet and resolves with the
 * person's choice. Render `sheet` once in the component.
 */
export function useCloudConsent() {
  const getFn = useServerFn(getCloudFeatures);
  const setFn = useServerFn(setCloudFeature);
  const [features, setFeatures] = useState<CloudFeatureState[] | null>(null);
  const [pending, setPending] = useState<CloudFeature | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await getFn();
      setFeatures(r.features);
      return r.features;
    } catch {
      setFeatures([]);
      return [] as CloudFeatureState[];
    }
  }, [getFn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isOn = useCallback(
    (f: CloudFeature) => !!features?.find((x) => x.feature === f)?.on,
    [features],
  );

  const ensure = useCallback(
    async (f: CloudFeature): Promise<boolean> => {
      const list = features ?? (await refresh());
      if (list.find((x) => x.feature === f)?.on) return true;
      return new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setPending(f);
      });
    },
    [features, refresh],
  );

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setPending(null);
  };

  const sheet = (
    <CloudFeatureSheet
      feature={pending}
      open={!!pending}
      busy={busy}
      onNotNow={() => finish(false)}
      onTurnOn={async () => {
        if (!pending) return;
        setBusy(true);
        try {
          const r = await setFn({ data: { feature: pending, granted: true, source: "prompt" } });
          setFeatures(r.features);
          finish(true);
        } catch {
          finish(false);
        } finally {
          setBusy(false);
        }
      }}
    />
  );

  return { features, isOn, ensure, refresh, sheet };
}
