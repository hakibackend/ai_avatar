/**
 * ConversationView — starts an Anam avatar session backed by an ElevenLabs
 * voice agent running server-side on the engine.
 *
 * The client only deals with the Anam SDK — mic audio is captured over
 * WebRTC, and the avatar video + audio are streamed back. All ElevenLabs
 * STT → LLM → TTS orchestration happens on the engine.
 */
"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { AnamEvent, createClient, type AnamClient } from "@anam-ai/js-sdk";
import type { Preset } from "@/app/page";

type Status = "idle" | "connecting" | "connected" | "error";

type Message = {
  id: string;
  role: "user" | "persona";
  content: string;
  interrupted?: boolean;
};

export default function ConversationView({
  presets,
}: {
  presets: Preset[];
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [trainerContext, setTrainerContext] = useState("");
  const [trainerGoal, setTrainerGoal] = useState("");

  // Ensure selected index is within bounds and get current preset safely
  const hasPresets = presets && presets.length > 0;
  const safeSelectedIndex = hasPresets ? Math.min(selectedIndex, presets.length - 1) : 0;
  const currentPreset = hasPresets ? presets[safeSelectedIndex] : null;

  const anamClientRef = useRef<AnamClient | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript to bottom when new messages arrive
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [messages]);

  const start = useCallback(async () => {
    if (!hasPresets || !currentPreset) {
      setError("No avatars configured");
      setStatus("error");
      return;
    }

    setStatus("connecting");
    setError(null);
    setMessages([]);

    try {
      const { avatarId, agentId } = currentPreset;

      const res = await fetch("/api/anam-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          avatarId,
          agentId,
          trainerContext: trainerContext.trim(),
          trainerGoal: trainerGoal.trim(),
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to get session token");
      }

      const { sessionToken } = await res.json();

      // Debug: decode JWT to inspect token type
      try {
        const payload = JSON.parse(atob(sessionToken.split(".")[1]));
        console.log("Token payload:", payload);
      } catch {}

      const anamClient = createClient(sessionToken, {
        ...(process.env.NEXT_PUBLIC_ANAM_API_URL && {
          api: { baseUrl: process.env.NEXT_PUBLIC_ANAM_API_URL },
        }),
      });
      anamClientRef.current = anamClient;

      // Stream events fire on every chunk; accumulate into messages by id
      anamClient.addListener(
        AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED,
        (evt: {
          id: string;
          content: string;
          role: string;
          endOfSpeech: boolean;
          interrupted: boolean;
        }) => {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === evt.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = {
                ...next[idx],
                content: next[idx].content + evt.content,
                interrupted: evt.interrupted,
              };
              return next;
            }
            return [
              ...prev,
              {
                id: evt.id,
                role: evt.role as "user" | "persona",
                content: evt.content,
                interrupted: evt.interrupted,
              },
            ];
          });
        }
      );

      anamClient.addListener(AnamEvent.CONNECTION_CLOSED, () => {
        setStatus("idle");
      });

      await anamClient.streamToVideoElement("avatar-video");
      setStatus("connected");
    } catch (err) {
      console.error("Start error:", err);
      // Anam SDK ClientError gắn nguyên nhân thật vào `details.cause`
      // và mã lỗi vào `code` — phải hiển thị để biết engine trả gì
      const errObj = err as {
        message?: string;
        code?: string;
        statusCode?: number;
        details?: { cause?: string };
      } | null;
      let message: string;
      if (err instanceof Error) {
        const cause = errObj?.details?.cause;
        const code = errObj?.code;
        const status = errObj?.statusCode;
        message = err.message;
        if (cause) message += ` — ${cause}`;
        if (code) message += ` [${code}${status ? ` ${status}` : ""}]`;
      } else if (typeof err === "object" && err !== null) {
        message = JSON.stringify(err);
      } else {
        message = String(err);
      }
      setError(message);
      setStatus("error");
    }
  }, [hasPresets, currentPreset, presets, selectedIndex, trainerContext, trainerGoal]);

  const stop = useCallback(async () => {
    try {
      await anamClientRef.current?.stopStreaming();
    } catch {}
    anamClientRef.current = null;
    setStatus("idle");
    setMessages([]); // Clear chat messages when conversation ends
  }, []);

  const nextAvatar = useCallback(() => {
    if (status === "connecting" || status === "connected") return;
    setSelectedIndex((prev) => (prev + 1) % presets.length);
  }, [presets.length, status]);

  const prevAvatar = useCallback(() => {
    if (status === "connecting" || status === "connected") return;
    setSelectedIndex((prev) => (prev - 1 + presets.length) % presets.length);
  }, [presets.length, status]);


  return (
    <>
      {/* Heading - fades out when session starts */}
      <div
        className="flex flex-col items-center gap-0.5 sm:gap-2 text-center flex-shrink-0 transition-opacity duration-500 ease-out motion-reduce:transition-none"
        style={{
          opacity: status === "connecting" || status === "connected" ? 0 : 1,
          maxHeight: status === "connecting" || status === "connected" ? 0 : "200px",
          pointerEvents: status === "connecting" || status === "connected" ? "none" : "auto",
        }}
      >
        <p className="text-black/70 text-[11px] sm:text-[32px] font-medium tracking-tight leading-tight sm:leading-[44px]">
          AI AVATAR
        </p>
      </div>

      {/* Trainer context & goal inputs — chỉ hiển thị khi chưa kết nối.
          Giá trị sẽ được truyền sang ElevenLabs qua dynamicVariables
          ({{trainer_context}} và {{trainer_goal}} trong system prompt). */}
      <div
        className="w-full max-w-lg lg:max-w-xl px-2 transition-all duration-500 ease-out motion-reduce:transition-none"
        style={{
          opacity: status === "connecting" || status === "connected" ? 0 : 1,
          maxHeight: status === "connecting" || status === "connected" ? 0 : "600px",
          pointerEvents: status === "connecting" || status === "connected" ? "none" : "auto",
          overflow: status === "connecting" || status === "connected" ? "hidden" : "visible",
        }}
      >
        <div className="flex flex-col gap-3 sm:gap-4">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="trainer-context"
              className="text-[11px] sm:text-sm font-medium text-black/70"
            >
              Bối cảnh của AI Trainer
            </label>
            <textarea
              id="trainer-context"
              value={trainerContext}
              onChange={(e) => setTrainerContext(e.target.value)}
              disabled={status === "connecting" || status === "connected"}
              placeholder="Cụ thể hóa việc AI Trainer đang ở trong tình huống nào và muốn nói về điều gì."
              rows={3}
              className="w-full rounded-xl sm:rounded-2xl border border-black/10 bg-white px-3 py-2 text-[12px] sm:text-sm text-black placeholder:text-black/40 focus:border-[#FF6200] focus:outline-none focus:ring-2 focus:ring-[#FF6200]/20 disabled:opacity-50 resize-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="trainer-goal"
              className="text-[11px] sm:text-sm font-medium text-black/70"
            >
              Mục tiêu của AI Trainer
            </label>
            <textarea
              id="trainer-goal"
              value={trainerGoal}
              onChange={(e) => setTrainerGoal(e.target.value)}
              disabled={status === "connecting" || status === "connected"}
              placeholder="Cụ thể hóa việc cuộc hội thoại này diễn ra để AI Trainer đạt được điều gì."
              rows={3}
              className="w-full rounded-xl sm:rounded-2xl border border-black/10 bg-white px-3 py-2 text-[12px] sm:text-sm text-black placeholder:text-black/40 focus:border-[#FF6200] focus:outline-none focus:ring-2 focus:ring-[#FF6200]/20 disabled:opacity-50 resize-none"
            />
          </div>
        </div>
      </div>

      <div
        className={`w-full flex flex-col items-center transition-all duration-500 ease-out motion-reduce:transition-none flex-shrink min-h-0 ${
          status === "connecting" || status === "connected"
            ? "gap-1 sm:gap-2"
            : "gap-2 sm:gap-4"
        }`}
      >
      {/* Video player with carousel controls */}
      <div className="w-full flex justify-center items-center gap-3 sm:gap-4 flex-shrink">
        {/* Left arrow - hidden when session starts */}
        {presets.length > 1 && status !== "connecting" && status !== "connected" && (
          <button
            onClick={prevAvatar}
            className="w-8 h-8 sm:w-12 sm:h-12 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm flex items-center justify-center group flex-shrink-0"
            aria-label="Previous avatar"
          >
            <svg
              className="w-4 h-4 sm:w-6 sm:h-6 text-white group-hover:scale-110 transition-transform"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}

        <div className="relative w-full max-w-lg lg:max-w-xl">
          {/* Avatar video - centered */}
          <div
            className="relative w-full aspect-[720/480] rounded-2xl sm:rounded-[32px] overflow-hidden"
          >
            <video
              id="avatar-video"
              autoPlay
              playsInline
              className="w-full h-full object-cover bg-black"
            />
            {status === "idle" && currentPreset && (
              <div
                className="absolute inset-0 flex items-center justify-center cursor-pointer"
                onClick={start}
              >
                <img
                  src={currentPreset.previewImage}
                  alt={currentPreset.label}
                  className="w-full h-full object-cover"
                />
              </div>
            )}
            {status === "connecting" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black">
                <div className="flex items-center gap-3 text-white">
                  <div className="w-2 h-2 bg-accent rounded-full animate-pulse" />
                  <span className="font-medium">Connecting...</span>
                </div>
              </div>
            )}

            {/* Start button - show at bottom of video when idle */}
            {status === "idle" && (
              <div className="absolute bottom-4 sm:bottom-8 left-0 right-0 flex justify-center pointer-events-none">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    start();
                  }}
                  className="pointer-events-auto min-w-[44px] min-h-[44px] w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center transition-all hover:scale-110 hover:bg-white/30 touch-action-manipulation"
                  style={{ WebkitTapHighlightColor: "transparent" }}
                  aria-label="Start conversation"
                >
                  <svg
                    className="w-6 h-6 sm:w-7 sm:h-7 text-white"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/>
                  </svg>
                </button>
              </div>
            )}

            {/* End button - show at bottom of video when connected */}
            {status === "connected" && (
              <div className="absolute bottom-4 sm:bottom-8 left-0 right-0 flex justify-center pointer-events-none">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    stop();
                  }}
                  className="pointer-events-auto min-w-[44px] min-h-[44px] w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-red-500/20 backdrop-blur-sm flex items-center justify-center transition-all hover:scale-110 hover:bg-red-500/30 touch-action-manipulation"
                  style={{ WebkitTapHighlightColor: "transparent" }}
                  aria-label="End conversation"
                >
                  <svg
                    className="w-6 h-6 sm:w-7 sm:h-7 text-red-500"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 00-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/>
                  </svg>
                </button>
              </div>
            )}
          </div>

        </div>

        {/* Right arrow - hidden when session starts */}
        {presets.length > 1 && status !== "connecting" && status !== "connected" && (
          <button
            onClick={nextAvatar}
            className="w-8 h-8 sm:w-12 sm:h-12 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-sm flex items-center justify-center group flex-shrink-0"
            aria-label="Next avatar"
          >
            <svg
              className="w-4 h-4 sm:w-6 sm:h-6 text-white group-hover:scale-110 transition-transform"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>

      {/* Thumbnail carousel - below video - fades when session starts */}
      {presets.length > 1 && (
        <div
          className="flex gap-1.5 sm:gap-3 justify-center items-center transition-all duration-500 ease-out motion-reduce:transition-none py-1 px-2"
          style={{
            opacity: status === "connecting" || status === "connected" ? 0 : 1,
            maxHeight: status === "connecting" || status === "connected" ? 0 : "200px",
            pointerEvents: status === "connecting" || status === "connected" ? "none" : "auto",
          }}
        >
          {presets.map((preset, i) => {
            const labelMatch = preset.label.match(/^(.+?)\s*(\[.+?\])?$/);
            const mainText = labelMatch?.[1] || preset.label;
            const badge = labelMatch?.[2] || "";

            return (
              <button
                key={i}
                onClick={() => setSelectedIndex(i)}
                disabled={status === "connecting" || status === "connected"}
                tabIndex={status === "connecting" || status === "connected" ? -1 : 0}
                className={`flex flex-col items-center gap-1 sm:gap-2 transition-all disabled:opacity-50 touch-action-manipulation w-[80px] sm:w-[140px] p-1 ${
                  i === selectedIndex ? "scale-105" : "scale-100 opacity-70 hover:opacity-100"
                }`}
                style={{ WebkitTapHighlightColor: "transparent" }}
              >
                {/* Thumbnail image */}
                <div
                  className={`w-12 h-12 sm:w-20 sm:h-20 rounded-lg sm:rounded-2xl overflow-hidden border-2 transition-all flex-shrink-0 ${
                    i === selectedIndex
                      ? "border-[#FF6200] shadow-lg"
                      : "border-transparent"
                  }`}
                >
                  <img
                    src={preset.previewImage}
                    alt={preset.label}
                    className="w-full h-full object-cover"
                  />
                </div>

                {/* Label - fixed height container */}
                <div className="flex items-start justify-center gap-0.5 w-full min-h-[24px] sm:min-h-[40px]">
                  <span
                    className="font-medium text-[9px] sm:text-sm text-center leading-tight"
                    style={{
                      color: i === selectedIndex ? "#FF6200" : "rgba(0, 0, 0, 0.65)",
                      fontFamily: "Inter",
                      fontWeight: 500,
                      letterSpacing: "-0.28px",
                    }}
                  >
                    {mainText}
                  </span>
                  {badge && (
                    <span
                      className="flex-shrink-0"
                      style={{
                        color: "#FF6200",
                        fontFamily: '"Geist Mono"',
                        fontSize: "7px",
                        fontWeight: 400,
                      }}
                    >
                      {badge}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col items-center gap-2 sm:gap-3 w-full max-w-lg lg:max-w-xl px-2">
        {status === "error" && error && (
          <span className="text-xs sm:text-sm text-accent px-4">Error: {error}</span>
        )}
      </div>

      {/* Transcript - show only when connected */}
      {status === "connected" && (
        <div
          className="w-full max-w-lg lg:max-w-xl h-60 sm:h-64 rounded-2xl sm:rounded-[32px] bg-white overflow-hidden transition-all duration-700 ease-out motion-reduce:transition-none"
          style={{
            opacity: 1,
            transform: "translateY(0)",
          }}
        >
          {/* Transcript - scrollable area */}
          <div
            ref={transcriptRef}
            className="h-full overflow-y-auto p-3 sm:p-4 space-y-2 sm:space-y-3 scroll-smooth"
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col gap-1 ${
                  msg.role === "user" ? "items-end" : "items-start"
                }`}
              >
                <span className="text-[11px] sm:text-sm text-gray uppercase tracking-wide font-medium">
                  {msg.role === "user" ? "YOU" : "AGENT"}
                </span>
                <div
                  className={`max-w-[85%] sm:max-w-[80%] rounded-xl sm:rounded-[16px] px-2.5 py-1.5 sm:px-4 sm:py-3 ${
                    msg.role === "user"
                      ? "bg-black text-white"
                      : "bg-gray-light text-black"
                  }`}
                >
                  <p
                    className={`text-[11px] sm:text-sm leading-relaxed ${
                      msg.interrupted ? "italic opacity-70" : ""
                    }`}
                  >
                    {msg.content}
                    {msg.interrupted && (
                      <span className="ml-2 text-[9px] sm:text-xs opacity-60">
                        (interrupted)
                      </span>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fork button at bottom center - fades when session starts */}
      <div
        className="fixed bottom-3 left-1/2 -translate-x-1/2 sm:bottom-6 z-10 transition-opacity duration-500 ease-out motion-reduce:transition-none"
        style={{
          opacity: status === "connecting" || status === "connected" ? 0 : 1,
          pointerEvents: status === "connecting" || status === "connected" ? "none" : "auto",
        }}
      >
        <a
          href="https://github.com/robbie-anam/elevenlabs-agent"
          target="_blank"
          rel="noopener noreferrer"
          className="px-3.5 sm:px-4 py-1.5 sm:py-2 rounded-full bg-white text-black hover:bg-black hover:text-white transition-colors text-sm font-medium whitespace-nowrap"
          tabIndex={status === "connecting" || status === "connected" ? -1 : 0}
        >
          Fork this project
        </a>
      </div>
    </div>
    </>
  );
}
