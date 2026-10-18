/** One-time notice for existing users after the switch to private by default. */
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { getPrivateDefaultNotice } from "@/lib/cloud-features.functions";

const KEY = "nc:private-default-notice-seen";

export function PrivateDefaultNotice() {
  const fn = useServerFn(getPrivateDefaultNotice);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (localStorage.getItem(KEY)) return;
    fn().then((r) => setShow(r.show)).catch(() => {});
  }, [fn]);
  if (!show) return null;
  const dismiss = () => {
    localStorage.setItem(KEY, "1");
    setShow(false);
  };
  return (
    <div role="status" className="mx-4 my-3 flex items-start gap-3 rounded-xl border bg-card/60 p-4 text-sm">
      <p className="flex-1">
        We've switched everything to private. Chat now runs on this device, and nothing goes to the cloud until
        you turn it on.{" "}
        <Link to="/workspace/privacy" onClick={dismiss} className="underline">
          Choose what to turn back on
        </Link>
      </p>
      <button aria-label="Dismiss" onClick={dismiss} className="text-muted-foreground hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
