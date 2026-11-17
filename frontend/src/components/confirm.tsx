// Asking before something can't be undone, without the browser's own confirm box: `const [confirm, dialog] = useConfirm()`,
// render `{dialog}`, then `if (await confirm({ title, body, action })) …`.
import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Ask = { title: string; body?: ReactNode; action: string; cancel?: string; destructive?: boolean };

export function useConfirm(): [(ask: Ask) => Promise<boolean>, ReactNode] {
  const [ask, setAsk] = useState<Ask | null>(null);
  const resolver = useRef<(yes: boolean) => void>(() => undefined);
  const confirm = useCallback((a: Ask) => new Promise<boolean>((resolve) => { resolver.current = resolve; setAsk(a); }), []);
  const close = (yes: boolean) => { resolver.current(yes); setAsk(null); };
  const dialog = (
    <AlertDialog open={!!ask} onOpenChange={(o) => { if (!o) close(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{ask?.title}</AlertDialogTitle>
          {ask?.body ? <AlertDialogDescription>{ask.body}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => close(false)}>{ask?.cancel ?? "Cancel"}</AlertDialogCancel>
          <AlertDialogAction className={ask?.destructive ? "bg-destructive text-white hover:bg-destructive/90" : undefined} onClick={() => close(true)}>{ask?.action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return [confirm, dialog];
}
