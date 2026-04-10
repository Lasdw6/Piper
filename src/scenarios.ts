import type { Scenario, TraceEvent } from "./types.js";

function event(
  id: string,
  phaseId: string,
  role: TraceEvent["role"],
  content: string,
  tags?: string[]
): TraceEvent {
  const traceEvent: TraceEvent = {
    id,
    phaseId,
    role,
    content,
    timestamp: new Date().toISOString()
  };

  if (tags !== undefined) {
    traceEvent.tags = tags;
  }

  return traceEvent;
}

export const scenarios: Scenario[] = [
  {
    id: "debugging",
    name: "Tool-heavy debugging run",
    maxContextTokens: 420,
    events: [
      event("e1", "setup", "system", "You are a coding agent. Keep notes concise and verify changes before finishing."),
      event("e2", "setup", "user", "Fix the failing auth flow in the dashboard app and make sure lint passes."),
      event("e3", "inspect", "assistant", "I will inspect the auth flow, reproduce the failure, and run lint after the fix.", ["inspect"]),
      event("e4", "inspect", "tool", "rg \"auth\" src/ --glob \"*.ts\" found middleware.ts, login.tsx, auth-client.ts", ["search"]),
      event("e5", "inspect", "tool", "pnpm test auth.spec.ts failed because refreshToken is undefined in middleware redirect path", ["test"]),
      event("e6", "fix", "assistant", "The refresh token is not forwarded during redirect. I will patch middleware and the login callback.", ["fix"]),
      event("e7", "fix", "tool", "Patched middleware.ts to preserve refreshToken and normalized callback return typing", ["edit"]),
      event("e8", "verify", "tool", "bun lint completed with 0 errors and 2 unrelated warnings in src/ui/theme.ts", ["verify"]),
      event("e9", "verify", "assistant", "Auth redirect is fixed and lint is clean enough to proceed.", ["verify"]),
      event("e10", "followup", "user", "What file had the unrelated lint warnings and what command was used to verify the fix?"),
      event("e11", "followup", "assistant", "I need the earlier verification details before answering.", ["followup"])
    ],
    probes: [
      {
        id: "p1",
        atEventId: "e11",
        query: "Which file had lint warnings and what command verified the fix?",
        expectAny: ["src/ui/theme.ts", "bun lint"]
      }
    ]
  },
  {
    id: "research",
    name: "Research and synthesis run",
    maxContextTokens: 460,
    events: [
      event("r1", "setup", "system", "You are a research agent. Preserve named entities and absolute numbers."),
      event("r2", "setup", "user", "Compare three observability vendors and recommend one for a 20-engineer team."),
      event("r3", "collect-a", "tool", "Vendor A pricing: base 1200 USD per month, retention 30 days, SOC2 available.", ["pricing"]),
      event("r4", "collect-a", "tool", "Vendor A issue: no self-hosting and weak audit export.", ["risk"]),
      event("r5", "collect-b", "tool", "Vendor B pricing: 900 USD per month, retention 14 days, strong traces and alert routing.", ["pricing"]),
      event("r6", "collect-b", "tool", "Vendor B issue: SSO only on enterprise plan.", ["risk"]),
      event("r7", "collect-c", "tool", "Vendor C pricing: usage based, estimated 1500 USD per month, retention 60 days, strong logs.", ["pricing"]),
      event("r8", "collect-c", "tool", "Vendor C issue: dashboard UX is slow for large traces.", ["risk"]),
      event("r9", "draft", "assistant", "Vendor B looks strongest on price to capability for a 20-engineer team, assuming SSO is not mandatory.", ["draft"]),
      event("r10", "followup", "user", "If SSO becomes mandatory, which vendor was blocked by plan limits and what was the retention of Vendor C?"),
      event("r11", "followup", "assistant", "I need to recall the vendor-specific constraints before answering.", ["followup"])
    ],
    probes: [
      {
        id: "p2",
        atEventId: "r11",
        query: "Which vendor had SSO only on enterprise and what was Vendor C retention?",
        expectAny: ["SSO only on enterprise plan", "60 days"]
      }
    ]
  }
];
