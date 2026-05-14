"use client";

// Renders an xterm.js terminal attached to a TUI harness (claude-code / codex)
// via a single WebSocket. The harness pod exposes /tty on the same port as the
// chat-mode harnesses' HTTP API, so we derive the WS URL directly from the
// session row's sandbox_url (http://<host>:<nodePort> → ws://<host>:<nodePort>/tty).
//
// Falls back to NEXT_PUBLIC_TUI_BRIDGE_URL for local dev against a standalone
// harness container (e.g. `docker run -p 4098:4096 claude-tty-poc`).
//
// Wire protocol:
//   browser → server : raw text (keystrokes)  OR  JSON {"type":"resize",cols,rows}
//   server  → browser: raw bytes (PTY stdout)

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

interface Props {
  sessionId: string;
  harnessId: string;
  // From SessionRow.sandbox_url — populated by the reconciler once the pod is
  // Running and the NodePort is bound. Null while the sandbox is still creating.
  sandboxUrl: string | null;
}

// http(s)://host:port  →  ws(s)://host:port/tty
function deriveTtyUrl(sandboxUrl: string): string {
  return sandboxUrl.replace(/^http(s?):\/\//i, "ws$1://").replace(/\/+$/, "") + "/tty";
}

type ConnState = "connecting" | "connected" | "closed" | "error";

export function TerminalPanel({ sessionId, harnessId, sandboxUrl }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ConnState>("connecting");
  const [reason, setReason] = useState<string>("");

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;
    let ws: WebSocket | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed || !hostRef.current) return;

      term = new Terminal({
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
        theme: {
          background: "#0b0c10",
          foreground: "#d4d4d8",
          cursor: "#a78bfa",
          selectionBackground: "#3f3f46",
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(hostRef.current);
      // Some browsers haven't laid the container out by the time we open;
      // fit needs a real width/height. requestAnimationFrame waits one frame.
      requestAnimationFrame(() => fit?.fit());

      // Prefer the live sandbox URL once the pod is ready; otherwise fall back
      // to the local-dev override (a standalone harness container).
      const url = sandboxUrl
        ? deriveTtyUrl(sandboxUrl)
        : process.env.NEXT_PUBLIC_TUI_BRIDGE_URL ?? "ws://localhost:4098/tty";

      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setState("connected");
        ws!.send(
          JSON.stringify({
            type: "resize",
            cols: term!.cols,
            rows: term!.rows,
          }),
        );
        term!.focus();
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") term?.write(e.data);
        else term?.write(new Uint8Array(e.data as ArrayBuffer));
      };
      ws.onclose = () => {
        if (disposed) return;
        setState("closed");
        term?.write("\r\n\x1b[2m[ws closed]\x1b[0m\r\n");
      };
      ws.onerror = () => {
        if (disposed) return;
        setState("error");
        setReason(`could not reach ${url}`);
      };

      term.onData((d) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(d);
      });

      const onResize = () => {
        fit?.fit();
        if (ws && ws.readyState === WebSocket.OPEN && term) {
          ws.send(
            JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
          );
        }
      };
      window.addEventListener("resize", onResize);

      // Stash cleanup on the closure so the outer effect can pick it up.
      (term as unknown as { _onResize?: () => void })._onResize = onResize;
    })();

    return () => {
      disposed = true;
      try {
        const cleanup = (term as unknown as { _onResize?: () => void } | null)
          ?._onResize;
        if (cleanup) window.removeEventListener("resize", cleanup);
      } catch {}
      try {
        ws?.close();
      } catch {}
      try {
        term?.dispose();
      } catch {}
    };
  }, [sessionId, harnessId, sandboxUrl]);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[#0b0c10]">
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-[#1f2229] text-[11px] font-mono text-[#71717a]">
        <span
          aria-hidden
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            state === "connected"
              ? "bg-emerald-500"
              : state === "connecting"
                ? "bg-amber-500"
                : "bg-red-500"
          }`}
        />
        <span>tty · {harnessId}</span>
        <span className="text-[#3f3f46]">·</span>
        <span>{state}</span>
        {reason && (
          <>
            <span className="text-[#3f3f46]">·</span>
            <span className="text-red-400">{reason}</span>
          </>
        )}
      </div>
      <div ref={hostRef} className="flex-1 min-h-0 p-2" />
    </div>
  );
}
