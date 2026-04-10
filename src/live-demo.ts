import { VercelAICompressionRuntime } from "./vercel-ai-runtime.js";

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for the live demo.");
  }

  const runtime = new VercelAICompressionRuntime({
    systemPrompt: "You are a coding assistant. Keep responses concise and rely on retrieved archive context when relevant.",
    compression: {
      mode: "hybrid",
      maxContextTokens: 800,
      compressAtRatio: 0.8,
      retrievalTopK: 3,
      phaseCompressionEnabled: true,
      messageDecayEnabled: true
    }
  });

  try {
    await runtime.recordToolResult(
      "bun lint",
      ".",
      "completed with 0 errors and 2 warnings in src/ui/theme.ts",
      "verify"
    );

    await runtime.recordToolResult(
      "pnpm test",
      "auth.spec.ts",
      "passed after refreshToken redirect fix in middleware.ts",
      "verify"
    );

    const response = await runtime.respond(
      "What command verified the fix and which file still had warnings?",
      {
        phaseId: "followup"
      }
    );

    console.log("");
    console.log("Assistant response:");
    console.log(response.text);
    console.log("");
    console.log("Retrieved archive entries:");
    console.log(response.retrievedContext.join("\n\n") || "(none)");
  } finally {
    runtime.close();
  }
}

void main();
