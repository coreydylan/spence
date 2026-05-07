/**
 * Anthropic API helpers for pipeline.
 * Handles Haiku (step generation) and Sonnet (drafting) calls,
 * including the Batch API for 50% cost reduction on bulk drafting.
 */

// ============================================================
// Direct API call (for Haiku — fast, cheap, no batching needed)
// ============================================================

export async function callHaiku(
  apiKey: string,
  system: string,
  user: string,
  maxTokens = 2000,
): Promise<{ result: string | null; usage: any; error: string | null }> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { result: null, usage: null, error: text };
  }

  const data = await resp.json() as any;
  const text = data.content?.[0]?.text || null;
  return { result: text, usage: data.usage, error: null };
}

// ============================================================
// Sonnet tool-use call (for single recipe drafting)
// ============================================================

export async function callSonnet(
  apiKey: string,
  system: string,
  user: string,
  toolSchema: any,
  maxTokens = 16000,
): Promise<{ result: any; usage: any; error: string | null }> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system: [{
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      }],
      messages: [{ role: "user", content: user }],
      tools: [{
        name: "write_recipe_draft",
        description: "Write the prose and editorial fields for a Spence canonical recipe.",
        input_schema: toolSchema,
        cache_control: { type: "ephemeral" },
      }],
      tool_choice: { type: "tool", name: "write_recipe_draft" },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { result: null, usage: null, error: text };
  }

  const data = await resp.json() as any;
  const toolBlock = data.content?.find((b: any) => b.type === "tool_use");
  if (!toolBlock) {
    return { result: null, usage: data.usage, error: "No tool_use block" };
  }
  return { result: toolBlock.input, usage: data.usage, error: null };
}

// ============================================================
// Batch API — 50% off for bulk drafting
// ============================================================

interface BatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    system: any;
    messages: any[];
    tools?: any[];
    tool_choice?: any;
  };
}

export async function createBatch(
  apiKey: string,
  requests: BatchRequest[],
): Promise<{ batch_id: string | null; error: string | null }> {
  // Build JSONL
  const jsonl = requests.map((r) => JSON.stringify(r)).join("\n");

  const resp = await fetch("https://api.anthropic.com/v1/messages/batches", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { batch_id: null, error: text };
  }

  const data = await resp.json() as any;
  return { batch_id: data.id, error: null };
}

export async function pollBatch(
  apiKey: string,
  batchId: string,
): Promise<{ status: string; results_url: string | null; counts: any; error: string | null }> {
  const resp = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { status: "error", results_url: null, counts: null, error: text };
  }

  const data = await resp.json() as any;
  return {
    status: data.processing_status,
    results_url: data.results_url || null,
    counts: data.request_counts,
    error: null,
  };
}

export async function fetchBatchResults(
  apiKey: string,
  batchId: string,
): Promise<{ results: any[]; error: string | null }> {
  const resp = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}/results`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { results: [], error: text };
  }

  // Results come as JSONL
  const text = await resp.text();
  const results = text.trim().split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  return { results, error: null };
}
