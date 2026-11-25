import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import { feedback } from "../feedback";

type ToastKind = "ok" | "err" | "info";
interface ToastMsg {
  id: number;
  text: string;
  kind: ToastKind;
}

const ToastCtx = createContext<(text: string, kind?: ToastKind) => void>(() => undefined);

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const timer = useRef<number>();

  const show = useCallback((text: string, kind: ToastKind = "info") => {
    window.clearTimeout(timer.current);
    setMsg({ id: Date.now(), text, kind });
    if (kind === "err") feedback("error");
    else if (kind === "ok") feedback("success");
    timer.current = window.setTimeout(() => setMsg(null), 2600);
  }, []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div key={msg.id} className={`toast ${msg.kind}`} role="status">
          {msg.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
