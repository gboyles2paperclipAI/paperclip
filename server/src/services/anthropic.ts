import { z } from "zod";
import { fetchWithTimeout } from "./fetch-with-timeout.js";

const anthropicResponseSchema = z.object({
  content: z.array(
    z.object({
      text: z.string(),
    }),
  ),
});

export async function getCompletion(
  prompt: string,
  model = "claude-3-haiku-20240307",
  retries = 3,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  for (let i = 0; i < retries; i += 1) {
    try {
      const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        throw new Error(`Anthropic API request failed with status ${response.status}`);
      }

      const json = await response.json();
      const parsed = anthropicResponseSchema.safeParse(json);

      if (!parsed.success) {
        throw new Error("Failed to parse Anthropic API response");
      }

      return parsed.data.content[0]?.text ?? "";
    } catch (error) {
      if (i === retries - 1) throw error;
    }
  }
  throw new Error("Anthropic API request failed after retries");
}
