/**
 * EPIC AI — абстракция LLM-провайдера.
 *
 * Провайдер меняется одной строкой в.env (AI_PROVIDER), бизнес-логика
 * RAG от него не зависит. Ключ API живёт только на backend.
 *
 * Поддерживаются:
 *   groq               — бесплатный API, OpenAI-совместимый (llama-3.3-70b-versatile)
 *   openai_compatible  — любой OpenAI-совместимый endpoint (OpenRouter, vLLM, LM Studio…)
 *   ollama             — полностью локально, без ключей и интернета
 *   mock               — детерминированная заглушка для разработки и тестов
 */
import { config } from '../../config/index.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Требовать JSON-ответ (если провайдер поддерживает response_format). */
  json?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  model: string;
  provider: string;
  tokensPrompt?: number;
  tokensCompletion?: number;
  latencyMs: number;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dim: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  embed?(texts: string[]): Promise<EmbeddingResult>;
  isConfigured(): { ok: boolean; reason?: string };
}

export class ProviderError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); }
}

/* ------------------------------------------------------------------ */
/*  OpenAI-совместимый провайдер (Groq, OpenAI, OpenRouter, vLLM)       */
/* ------------------------------------------------------------------ */

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  constructor(
    name: string,
    private baseUrl: string,
    private apiKey: string,
    model: string,
    private defaults: { temperature: number; maxTokens: number; timeoutMs: number },
  ) {
    this.name = name;
    this.model = model;
  }

  isConfigured() {
    if (!this.baseUrl) return { ok: false, reason: 'Не задан AI_BASE_URL' };
    if (!this.apiKey) return { ok: false, reason: `Не задан AI_API_KEY для провайдера ${this.name}` };
    if (!this.model) return { ok: false, reason: 'Не задана AI_MODEL' };
    return { ok: true };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? this.defaults.temperature,
      max_tokens: opts.maxTokens ?? this.defaults.maxTokens,
      stream: false,
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(this.defaults.timeoutMs),
      });
    } catch (e: any) {
      throw new ProviderError(`Сетевая ошибка AI-провайдера ${this.name}: ${e.message}`, e);
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new ProviderError(`AI-провайдер ${this.name} вернул ${res.status}: ${txt.slice(0, 400)}`);
    }
    const data: any = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model: data?.model ?? this.model,
      provider: this.name,
      tokensPrompt: data?.usage?.prompt_tokens,
      tokensCompletion: data?.usage?.completion_tokens,
      latencyMs: Date.now() - started,
    };
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (!config.ai.embedding.enabled || !config.ai.embedding.model) {
      throw new ProviderError('Embeddings отключены (EMBEDDING_ENABLED=false)');
    }
    const base = (config.ai.embedding.baseUrl || this.baseUrl).replace(/\/$/, '');
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: config.ai.embedding.model, input: texts }),
      signal: AbortSignal.timeout(this.defaults.timeoutMs),
    });
    if (!res.ok) throw new ProviderError(`Embeddings API вернул ${res.status}`);
    const data: any = await res.json();
    const vectors: number[][] = (data?.data ?? []).map((d: any) => d.embedding as number[]);
    return { vectors, model: config.ai.embedding.model, dim: vectors[0]?.length ?? 0 };
  }
}

/* ------------------------------------------------------------------ */
/*  Ollama (локально, без ключей)                                       */
/* ------------------------------------------------------------------ */

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly model: string;
  constructor(model: string, private baseUrl = config.ai.ollamaBaseUrl) { this.model = model; }
  isConfigured() {
    if (!this.model) return { ok: false, reason: 'Не задана AI_MODEL для ollama' };
    return { ok: true };
  }
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        format: opts.json ? 'json' : undefined,
        options: { temperature: opts.temperature ?? 0.1, num_predict: opts.maxTokens ?? 1200 },
      }),
      signal: opts.signal ?? AbortSignal.timeout(config.ai.timeoutMs),
    });
    if (!res.ok) throw new ProviderError(`Ollama вернул ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    return {
      content: String(data?.message?.content ?? ''),
      model: this.model,
      provider: this.name,
      tokensPrompt: data?.prompt_eval_count,
      tokensCompletion: data?.eval_count,
      latencyMs: Date.now() - started,
    };
  }
  async embed(texts: string[]): Promise<EmbeddingResult> {
    const vectors: number[][] = [];
    for (const t of texts) {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.ai.embedding.model || this.model, prompt: t }),
        signal: AbortSignal.timeout(config.ai.timeoutMs),
      });
      if (!res.ok) throw new ProviderError(`Ollama embeddings вернул ${res.status}`);
      const data: any = await res.json();
      vectors.push(data.embedding as number[]);
    }
    return { vectors, model: config.ai.embedding.model || this.model, dim: vectors[0]?.length ?? 0 };
  }
}

/* ------------------------------------------------------------------ */
/*  Mock — детерминированная заглушка (разработка / тесты / офлайн)      */
/* ------------------------------------------------------------------ */

export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly model = 'mock-epic-ai';
  constructor(private opts: { sourcesCount?: number } = {}) {}
  isConfigured() { return { ok: true }; }
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const started = Date.now();
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    // В mock-режиме честно отвечаем «нет подтверждённых данных», если контекст пуст.
    const hasContext = /ДОКУМЕНТ:/i.test(lastUser);
    const payload = hasContext
      ? {
          verdict: 'depends',
          explanation: 'Тестовый режим (AI_PROVIDER=mock). Ответ сформирован по найденным фрагментам официальной базы EpicRP без обращения к внешней модели.',
          basis: 'Фрагменты, переданные в контексте запроса.',
          source_indexes: Array.from({ length: Math.min(this.opts.sourcesCount ?? 3, 3) }, (_, i) => i),
          confidence: 0.5,
        }
      : {
          verdict: 'unknown',
          explanation: 'В официальной базе EpicRP не найдено подтверждённой информации для однозначного ответа.',
          basis: null,
          source_indexes: [],
          confidence: 0,
        };
    return {
      content: JSON.stringify(payload, null, 2),
      model: this.model,
      provider: this.name,
      latencyMs: Date.now() - started,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Фабрика                                                             */
/* ------------------------------------------------------------------ */

let cached: LLMProvider | null = null;

export function getProvider(): LLMProvider {
  if (cached) return cached;
  const d = {
    temperature: config.ai.temperature,
    maxTokens: config.ai.maxTokens,
    timeoutMs: config.ai.timeoutMs,
  };
  switch (config.ai.provider) {
    case 'groq':
      cached = new OpenAICompatibleProvider('groq', config.ai.baseUrl || 'https://api.groq.com/openai/v1', config.ai.apiKey, config.ai.model || 'llama-3.3-70b-versatile', d);
      break;
    case 'openai_compatible':
      cached = new OpenAICompatibleProvider('openai_compatible', config.ai.baseUrl, config.ai.apiKey, config.ai.model, d);
      break;
    case 'ollama':
      cached = new OllamaProvider(config.ai.model);
      break;
    case 'mock':
    default:
      cached = new MockProvider();
      break;
  }
  return cached;
}

export function resetProviderCache(): void { cached = null; }
