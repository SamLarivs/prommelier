import { useState, useRef, useEffect } from "react";
import type { CSSProperties, ReactNode, MouseEvent as ReactMouseEvent } from "react";

// ----------------------------------------------------------------
// Prommelier: a blind tasting room for your prompts.
// Pipeline: Draft -> Diagnose -> Refine -> Prove (blind A/B eval)
// ----------------------------------------------------------------

const MODEL = "claude-sonnet-4-6";

const INK = "#141B2E";
const ULTRA = "#2B4BE0";
const AMBER = "#B26F0E";
const GREEN = "#178A63";
const PAPER = "#EFF2F5";
const CARD = "#FFFFFF";
const LINE = "#D7DDE6";
const MUTE = "#5C6678";

// ---- Model response contracts ----------------------------------

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Dimension {
  name: string;
  score: number;
  finding: string;
}

interface ClarifyingQuestion {
  q: string;
  why: string;
}

interface Diagnosis {
  overall: number;
  verdict: string;
  dimensions: Dimension[];
  questions: ClarifyingQuestion[];
}

interface PromptChange {
  what: string;
  why: string;
}

interface OptimizedPrompt {
  prompt: string;
  changes: PromptChange[];
}

interface Criterion {
  name: string;
  a: number;
  b: number;
}

interface Judgment {
  criteria: Criterion[];
  winner: "A" | "B" | "tie";
  summary: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isDiagnosis(v: unknown): v is Diagnosis {
  return (
    isRecord(v) &&
    typeof v.overall === "number" &&
    typeof v.verdict === "string" &&
    Array.isArray(v.dimensions) &&
    v.dimensions.every(
      (d) => isRecord(d) && typeof d.name === "string" && typeof d.score === "number" && typeof d.finding === "string"
    ) &&
    Array.isArray(v.questions) &&
    v.questions.every((q) => isRecord(q) && typeof q.q === "string" && typeof q.why === "string")
  );
}

function isOptimized(v: unknown): v is OptimizedPrompt {
  return (
    isRecord(v) &&
    typeof v.prompt === "string" &&
    Array.isArray(v.changes) &&
    v.changes.every((c) => isRecord(c) && typeof c.what === "string" && typeof c.why === "string")
  );
}

function isJudgment(v: unknown): v is Judgment {
  return (
    isRecord(v) &&
    (v.winner === "A" || v.winner === "B" || v.winner === "tie") &&
    typeof v.summary === "string" &&
    Array.isArray(v.criteria) &&
    v.criteria.every(
      (c) => isRecord(c) && typeof c.name === "string" && typeof c.a === "number" && typeof c.b === "number"
    )
  );
}

async function callClaude(apiKey: string, messages: Message[], system?: string): Promise<string> {
  const body: { model: string; max_tokens: number; messages: Message[]; system?: string } = {
    model: MODEL,
    max_tokens: 1500,
    messages,
  };
  if (system) body.system = system;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data: { content?: Array<{ type: string; text?: string }> } = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

function parseJSON<T>(text: string, validate: (v: unknown) => v is T): T {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  if (start === -1) throw new Error("No JSON found");
  // Scan for the brace matching the first "{", skipping braces inside strings,
  // so trailing prose after the object can't extend the slice.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (escaped) {
      escaped = false;
    } else if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("No JSON found");
  const parsed: unknown = JSON.parse(clean.slice(start, end + 1));
  if (!validate(parsed)) throw new Error("Response JSON failed contract validation");
  return parsed;
}

// ---- Stage prompts ---------------------------------------------

const DIAGNOSE_SYSTEM = `You are a rigorous prompt engineering analyst. You evaluate prompts written for large language models against the six components that research and practice consistently show determine output quality: Task clarity, Context, Constraints, Output format, Examples, Audience & tone.

Score each dimension 0-10 based ONLY on what is present in the prompt. Be strict: a vague one-line prompt should score low on most dimensions. Note: not every prompt needs every dimension maxed. A simple factual question doesn't need examples. Score "n/a but fine" cases as 7+ with a note saying it isn't needed.

Then identify the 2-4 clarifying questions whose answers would MOST improve this specific prompt. Only ask questions that materially change the output. Never ask generic questions.

Respond with ONLY a JSON object, no markdown fences, no preamble:
{
  "overall": <0-100 integer>,
  "verdict": "<one blunt sentence on the prompt's biggest weakness>",
  "dimensions": [
    {"name": "Task clarity", "score": <0-10>, "finding": "<max 14 words, specific>"},
    {"name": "Context", "score": <0-10>, "finding": "..."},
    {"name": "Constraints", "score": <0-10>, "finding": "..."},
    {"name": "Output format", "score": <0-10>, "finding": "..."},
    {"name": "Examples", "score": <0-10>, "finding": "..."},
    {"name": "Audience & tone", "score": <0-10>, "finding": "..."}
  ],
  "questions": [
    {"q": "<clarifying question>", "why": "<max 10 words: what it unlocks>"}
  ]
}`;

const OPTIMIZE_SYSTEM = `You are an expert prompt engineer. Rewrite the user's prompt into a production-quality prompt using their diagnosis and their answers to clarifying questions.

Rules:
- Preserve the user's actual intent. Never invent facts, data, or context they didn't supply. Where essential information is still missing, insert a clearly marked placeholder like [DESCRIBE YOUR PRODUCT].
- Structure the prompt cleanly. Use short labeled sections or XML tags (e.g. <context>, <task>, <constraints>, <format>) when the prompt is complex enough to benefit; keep simple prompts simple.
- Add only components that earn their place. Do not pad. A great prompt is the shortest one that fully specifies the job.
- Specify output format concretely. Include a brief example of the desired output shape if it would help.
- If unanswered clarifying questions were skipped, make reasonable defaults explicit in the prompt rather than leaving ambiguity.

Respond with ONLY a JSON object, no markdown fences:
{
  "prompt": "<the full rewritten prompt>",
  "changes": [
    {"what": "<max 8 words>", "why": "<max 14 words>"}
  ]
}`;

const JUDGE_SYSTEM = `You are a blind evaluator of LLM outputs. You will receive an original task intent and two responses labeled A and B. You do NOT know which prompt produced which. Judge only the responses.

Score each response 0-10 on:
1. Instruction adherence: does it do what the task intent asked?
2. Specificity: concrete and usable vs. generic filler?
3. Completeness: covers the full scope without padding?
4. Format & structure: is the shape of the answer fit for use?
5. Overall usefulness: would the requester ship this?

Be decisive. Identical scores across the board are almost never correct.

Respond with ONLY a JSON object, no markdown fences:
{
  "criteria": [
    {"name": "Instruction adherence", "a": <0-10>, "b": <0-10>},
    {"name": "Specificity", "a": <0-10>, "b": <0-10>},
    {"name": "Completeness", "a": <0-10>, "b": <0-10>},
    {"name": "Format & structure", "a": <0-10>, "b": <0-10>},
    {"name": "Overall usefulness", "a": <0-10>, "b": <0-10>}
  ],
  "winner": "A" | "B" | "tie",
  "summary": "<max 30 words, blunt, comparative>"
}`;

// ---- UI atoms --------------------------------------------------

function ScoreBar({ score, color }: { score: number; color: string }) {
  return (
    <div style={{ flex: 1, height: 6, background: "#E4E9F0", borderRadius: 3, overflow: "hidden" }}>
      <div
        style={{
          width: `${score * 10}%`,
          height: "100%",
          background: color,
          borderRadius: 3,
          transition: "width 700ms cubic-bezier(.2,.8,.2,1)",
        }}
      />
    </div>
  );
}

function StageMarker({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: active || done ? 1 : 0.35 }}>
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 700,
          fontSize: 13,
          background: done ? GREEN : active ? ULTRA : "transparent",
          color: done || active ? "#fff" : MUTE,
          border: done || active ? "none" : `1.5px solid ${LINE}`,
          flexShrink: 0,
        }}
      >
        {done ? "\u2713" : n}
      </div>
      <span
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 600,
          fontSize: 12,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: active ? INK : MUTE,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 0" }}>
      <div className="pp-spin" />
      <span style={{ fontSize: 13, color: MUTE, fontFamily: "'JetBrains Mono', monospace" }}>{label}</span>
    </div>
  );
}

interface BtnProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "green";
  small?: boolean;
}

function Btn({ children, onClick, disabled, variant = "primary", small }: BtnProps) {
  const styles: CSSProperties = ({
    primary: { background: ULTRA, color: "#fff", border: "none" },
    ghost: { background: "transparent", color: INK, border: `1.5px solid ${LINE}` },
    green: { background: GREEN, color: "#fff", border: "none" },
  } as Record<"primary" | "ghost" | "green", CSSProperties>)[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles,
        padding: small ? "8px 14px" : "13px 22px",
        borderRadius: 10,
        fontFamily: "'Space Grotesk', sans-serif",
        fontWeight: 600,
        fontSize: small ? 13 : 15,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "transform 120ms, opacity 120ms",
      }}
      onMouseDown={(e: ReactMouseEvent<HTMLButtonElement>) => !disabled && (e.currentTarget.style.transform = "scale(0.97)")}
      onMouseUp={(e: ReactMouseEvent<HTMLButtonElement>) => (e.currentTarget.style.transform = "scale(1)")}
      onMouseLeave={(e: ReactMouseEvent<HTMLButtonElement>) => (e.currentTarget.style.transform = "scale(1)")}
    >
      {children}
    </button>
  );
}

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: CARD,
        border: `1px solid ${LINE}`,
        borderRadius: 14,
        padding: 18,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ---- Main app --------------------------------------------------

export default function Prommelier() {
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState("");
  const [purpose, setPurpose] = useState("");
  const [stage, setStage] = useState(0); // 0 draft, 1 diagnosed, 2 optimized, 3 proven
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [optimized, setOptimized] = useState<OptimizedPrompt | null>(null);
  const [runA, setRunA] = useState("");
  const [runB, setRunB] = useState("");
  const [judgment, setJudgment] = useState<Judgment | null>(null);
  const [flip, setFlip] = useState(false); // true -> A = optimized
  const [copied, setCopied] = useState(false);
  const [showOutputs, setShowOutputs] = useState(false);
  const resultRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (resultRef.current) resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [stage]);

  const ready = prompt.trim() && apiKey.trim();

  const fail = (e: unknown) => {
    console.error(e);
    setError(
      String(e).includes("401")
        ? "The API rejected that key. Double-check it and try again."
        : "That call didn't come back clean. Try again. Model responses occasionally break format."
    );
    setBusy("");
  };

  async function diagnose() {
    setError("");
    setBusy("Scoring your prompt against the six-component anatomy\u2026");
    try {
      const text = await callClaude(
        apiKey,
        [{ role: "user", content: `Prompt to analyze:\n<<<\n${prompt}\n>>>\n\nStated purpose (may be empty): ${purpose || "not given"}` }],
        DIAGNOSE_SYSTEM
      );
      const d = parseJSON(text, isDiagnosis);
      setDiagnosis(d);
      setAnswers({});
      setStage(1);
      setBusy("");
    } catch (e) {
      fail(e);
    }
  }

  async function optimize() {
    if (!diagnosis) return;
    setError("");
    setBusy("Rewriting with your answers folded in\u2026");
    try {
      const qa = diagnosis.questions
        .map((q, i) => `Q: ${q.q}\nA: ${answers[i]?.trim() || "(skipped, use an explicit sensible default)"}`)
        .join("\n\n");
      const text = await callClaude(
        apiKey,
        [
          {
            role: "user",
            content: `Original prompt:\n<<<\n${prompt}\n>>>\n\nPurpose: ${purpose || "not given"}\n\nDiagnosis verdict: ${diagnosis.verdict}\nWeak dimensions: ${diagnosis.dimensions
              .filter((d) => d.score < 7)
              .map((d) => `${d.name} (${d.score}/10: ${d.finding})`)
              .join("; ") || "none"}\n\nClarifying Q&A:\n${qa || "none"}`,
          },
        ],
        OPTIMIZE_SYSTEM
      );
      const o = parseJSON(text, isOptimized);
      setOptimized(o);
      setStage(2);
      setBusy("");
    } catch (e) {
      fail(e);
    }
  }

  async function prove() {
    if (!optimized) return;
    setError("");
    setJudgment(null);
    setShowOutputs(false);
    const coin = Math.random() < 0.5;
    setFlip(coin);
    try {
      setBusy("Run 1 of 2, executing original prompt\u2026");
      const outOrig = await callClaude(apiKey, [{ role: "user", content: prompt }]);
      setBusy("Run 2 of 2, executing optimized prompt\u2026");
      const outOpt = await callClaude(apiKey, [{ role: "user", content: optimized.prompt }]);
      const a = coin ? outOpt : outOrig;
      const b = coin ? outOrig : outOpt;
      setRunA(a);
      setRunB(b);
      setBusy("Tasting blind, labels randomized to kill position bias\u2026");
      const text = await callClaude(
        apiKey,
        [
          {
            role: "user",
            content: `Task intent: ${purpose || prompt.slice(0, 300)}\n\n<response_a>\n${a}\n</response_a>\n\n<response_b>\n${b}\n</response_b>`,
          },
        ],
        JUDGE_SYSTEM
      );
      const j = parseJSON(text, isJudgment);
      setJudgment(j);
      setStage(3);
      setBusy("");
    } catch (e) {
      fail(e);
    }
  }

  function copyOptimized() {
    if (!optimized) return;
    navigator.clipboard.writeText(optimized.prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  function resetAll() {
    setStage(0);
    setDiagnosis(null);
    setOptimized(null);
    setJudgment(null);
    setAnswers({});
    setError("");
  }

  // winner mapping back through the blind
  const optLabel = flip ? "A" : "B";
  const optWon = judgment && judgment.winner === optLabel;
  const tie = judgment && judgment.winner === "tie";
  const totals = judgment
    ? judgment.criteria.reduce(
        (acc, c) => {
          acc.orig += flip ? c.b : c.a;
          acc.opt += flip ? c.a : c.b;
          return acc;
        },
        { orig: 0, opt: 0 }
      )
    : null;

  return (
    <div style={{ minHeight: "100vh", background: PAPER, color: INK, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        textarea, input { font-family: 'JetBrains Mono', monospace; }
        textarea:focus, input:focus { outline: 2px solid ${ULTRA}; outline-offset: -1px; }
        button:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; }
        .pp-spin {
          width: 15px; height: 15px; border-radius: 50%;
          border: 2px solid ${LINE}; border-top-color: ${ULTRA};
          animation: ppspin 700ms linear infinite; flex-shrink: 0;
        }
        @keyframes ppspin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .pp-spin { animation-duration: 2s; }
          * { transition: none !important; }
        }
      `}</style>

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "28px 16px 80px" }}>
        {/* Masthead */}
        <header style={{ marginBottom: 26 }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              letterSpacing: "0.14em",
              color: ULTRA,
              marginBottom: 6,
            }}
          >
            DIAGNOSE → REFINE → PROVE
          </div>
          <h1
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontSize: 34,
              fontWeight: 700,
              margin: 0,
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
            }}
          >
            Prommelier
          </h1>
          <p style={{ color: MUTE, fontSize: 14, margin: "10px 0 0", lineHeight: 1.5 }}>
            Frameworks tell you what a prompt <em>should</em> contain. This is a blind tasting room: it measures
            what yours is missing, rewrites it, then pours both versions for a judge who doesn't know which
            is which.
          </p>
        </header>

        {/* API key */}
        <Card style={{ marginBottom: 16 }}>
          <label style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 14 }}>
            Anthropic API key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            autoComplete="off"
            style={{
              width: "100%",
              marginTop: 10,
              padding: 12,
              fontSize: 13,
              border: `1px solid ${LINE}`,
              borderRadius: 10,
              background: "#FBFCFE",
            }}
          />
          <p style={{ fontSize: 12, color: MUTE, margin: "8px 0 0", lineHeight: 1.5 }}>
            Calls go straight from your browser to the Anthropic API. The key lives in component state only:
            never persisted, never sent anywhere else. Get one at console.anthropic.com.
          </p>
        </Card>

        {/* Stage rail */}
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 22 }}>
          <StageMarker n={1} label="Draft" active={stage === 0} done={stage > 0} />
          <StageMarker n={2} label="Diagnose" active={stage === 1} done={stage > 1} />
          <StageMarker n={3} label="Refine" active={stage === 2} done={stage > 2} />
          <StageMarker n={4} label="Prove" active={stage === 3} done={false} />
        </div>

        {/* Stage 1: Draft */}
        <Card>
          <label style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 14 }}>
            Your prompt, as you'd type it today
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={"e.g. write me a blog post about our new API"}
            rows={5}
            style={{
              width: "100%",
              marginTop: 10,
              padding: 12,
              fontSize: 13,
              lineHeight: 1.55,
              border: `1px solid ${LINE}`,
              borderRadius: 10,
              resize: "vertical",
              background: "#FBFCFE",
            }}
          />
          <label style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 14, display: "block", marginTop: 14 }}>
            What's it for? <span style={{ color: MUTE, fontWeight: 400 }}>(optional, sharpens the judge)</span>
          </label>
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. dev-facing launch post, ~600 words, technical but friendly"
            style={{
              width: "100%",
              marginTop: 10,
              padding: 12,
              fontSize: 13,
              border: `1px solid ${LINE}`,
              borderRadius: 10,
              background: "#FBFCFE",
            }}
          />
          <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
            <Btn onClick={diagnose} disabled={!ready || !!busy}>
              Diagnose prompt
            </Btn>
            {stage > 0 && (
              <Btn variant="ghost" onClick={resetAll} small>
                Start over
              </Btn>
            )}
          </div>
        </Card>

        {busy && stage === 0 && <Spinner label={busy} />}
        {error && (
          <div style={{ marginTop: 12, padding: "12px 14px", background: "#FCEFEF", border: "1px solid #E8C4C4", borderRadius: 10, fontSize: 13, color: "#8A2A2A" }}>
            {error}
          </div>
        )}

        {/* Stage 2: Diagnosis */}
        {diagnosis && (
          <div ref={stage === 1 ? resultRef : null} style={{ marginTop: 20 }}>
            <Card>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
                <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 42, fontWeight: 700, color: diagnosis.overall >= 70 ? GREEN : diagnosis.overall >= 40 ? AMBER : "#B03030" }}>
                  {diagnosis.overall}
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: MUTE }}>/ 100 · prompt anatomy score</span>
              </div>
              <p style={{ fontSize: 14, lineHeight: 1.5, margin: "4px 0 18px", fontWeight: 500 }}>{diagnosis.verdict}</p>

              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {diagnosis.dimensions.map((d) => (
                  <div key={d.name}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 13, fontWeight: 600 }}>{d.name}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: MUTE }}>{d.score}/10</span>
                    </div>
                    <ScoreBar score={d.score} color={d.score >= 7 ? GREEN : d.score >= 4 ? AMBER : "#B03030"} />
                    <div style={{ fontSize: 12, color: MUTE, marginTop: 4 }}>{d.finding}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Clarifying questions */}
            {diagnosis.questions.length > 0 && (
              <Card style={{ marginTop: 14 }}>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
                  Answer what you can, skip the rest
                </div>
                <p style={{ fontSize: 13, color: MUTE, margin: "0 0 14px" }}>
                  These are the specific gaps holding this prompt back. Skipped questions become explicit defaults, not silent ambiguity.
                </p>
                {diagnosis.questions.map((q, i) => (
                  <div key={i} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.45 }}>{q.q}</div>
                    <div style={{ fontSize: 11.5, color: ULTRA, fontFamily: "'JetBrains Mono', monospace", margin: "3px 0 6px" }}>
                      ↳ {q.why}
                    </div>
                    <input
                      value={answers[i] || ""}
                      onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
                      placeholder="your answer (or leave blank)"
                      style={{ width: "100%", padding: 10, fontSize: 13, border: `1px solid ${LINE}`, borderRadius: 8, background: "#FBFCFE" }}
                    />
                  </div>
                ))}
                <Btn onClick={optimize} disabled={!!busy}>
                  Build optimized prompt
                </Btn>
              </Card>
            )}
            {busy && stage === 1 && <Spinner label={busy} />}
          </div>
        )}

        {/* Stage 3: Optimized */}
        {optimized && (
          <div ref={stage === 2 ? resultRef : null} style={{ marginTop: 20 }}>
            <Card style={{ borderColor: ULTRA, borderWidth: 1.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 15 }}>Optimized prompt</span>
                <Btn variant="ghost" small onClick={copyOptimized}>
                  {copied ? "Copied \u2713" : "Copy"}
                </Btn>
              </div>
              <pre
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  background: "#F4F6FA",
                  border: `1px solid ${LINE}`,
                  borderRadius: 10,
                  padding: 14,
                  margin: 0,
                  maxHeight: 340,
                  overflowY: "auto",
                }}
              >
                {optimized.prompt}
              </pre>
              <div style={{ marginTop: 14 }}>
                {optimized.changes.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, fontSize: 12.5, marginBottom: 6, lineHeight: 1.45 }}>
                    <span style={{ color: GREEN, fontWeight: 700 }}>+</span>
                    <span>
                      <strong>{c.what}.</strong> <span style={{ color: MUTE }}>{c.why}</span>
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px dashed ${LINE}` }}>
                <Btn variant="green" onClick={prove} disabled={!!busy}>
                  Prove it: run a blind tasting
                </Btn>
                <p style={{ fontSize: 12, color: MUTE, margin: "10px 0 0", lineHeight: 1.5 }}>
                  Runs both prompts live, then a judge scores the outputs with randomized blind labels. It can't
                  favor the rewrite because it doesn't know which is which.
                </p>
              </div>
            </Card>
            {busy && stage === 2 && <Spinner label={busy} />}
          </div>
        )}

        {/* Stage 4: Verdict */}
        {judgment && totals && (
          <div ref={stage === 3 ? resultRef : null} style={{ marginTop: 20 }}>
            <Card style={{ background: INK, color: "#F2F4F8", border: "none" }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: "0.12em", color: "#8FA0C4", marginBottom: 10 }}>
                BLIND TASTING · LABELS UNBLINDED
              </div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, fontWeight: 700, lineHeight: 1.2, marginBottom: 6 }}>
                {tie ? "Indistinguishable vintages." : optWon ? "The rewrite wins the tasting." : "The original held its ground."}
              </div>
              <div style={{ fontSize: 13.5, color: "#C4CDDF", lineHeight: 1.5, marginBottom: 18 }}>{judgment.summary}</div>

              {/* Totals */}
              <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
                {[
                  { label: "Original", val: totals.orig, color: "#D9A34A" },
                  { label: "Optimized", val: totals.opt, color: "#6C8CFF" },
                ].map((t) => (
                  <div key={t.label} style={{ flex: 1, background: "#1E2740", borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#8FA0C4" }}>{t.label}</div>
                    <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 30, fontWeight: 700, color: t.color }}>
                      {t.val}
                      <span style={{ fontSize: 13, color: "#8FA0C4", fontWeight: 500 }}> / 50</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Per-criterion */}
              {judgment.criteria.map((c) => {
                const orig = flip ? c.b : c.a;
                const opt = flip ? c.a : c.b;
                return (
                  <div key={c.name} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{c.name}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#8FA0C4" }}>
                        <span style={{ color: "#D9A34A" }}>{orig}</span> · <span style={{ color: "#6C8CFF" }}>{opt}</span>
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <div style={{ flex: 1, height: 5, background: "#2A3450", borderRadius: 3 }}>
                        <div style={{ width: `${orig * 10}%`, height: "100%", background: "#D9A34A", borderRadius: 3 }} />
                      </div>
                      <div style={{ flex: 1, height: 5, background: "#2A3450", borderRadius: 3 }}>
                        <div style={{ width: `${opt * 10}%`, height: "100%", background: "#6C8CFF", borderRadius: 3 }} />
                      </div>
                    </div>
                  </div>
                );
              })}

              <button
                onClick={() => setShowOutputs(!showOutputs)}
                style={{
                  marginTop: 8,
                  background: "transparent",
                  border: "1px solid #3A4666",
                  color: "#C4CDDF",
                  borderRadius: 8,
                  padding: "8px 14px",
                  fontSize: 12.5,
                  fontFamily: "'Space Grotesk', sans-serif",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {showOutputs ? "Hide raw outputs" : "Inspect raw outputs"}
              </button>
            </Card>

            {showOutputs && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
                {[
                  { title: "Original prompt \u2192 output", text: flip ? runB : runA, color: AMBER },
                  { title: "Optimized prompt \u2192 output", text: flip ? runA : runB, color: ULTRA },
                ].map((o) => (
                  <Card key={o.title}>
                    <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: 13, color: o.color, marginBottom: 8 }}>
                      {o.title}
                    </div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.6, whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto", color: "#333C4E" }}>
                      {o.text}
                    </div>
                  </Card>
                ))}
              </div>
            )}

            <div style={{ marginTop: 14, display: "flex", gap: 10 }}>
              <Btn variant="ghost" small onClick={prove} disabled={!!busy}>
                Re-run eval
              </Btn>
              <Btn variant="ghost" small onClick={resetAll}>
                Start another prompt
              </Btn>
            </div>
            {busy && stage === 3 && <Spinner label={busy} />}
          </div>
        )}
      </div>
    </div>
  );
}
