import { createClient } from '@supabase/supabase-js'

// Server-side client (uses service role — never expose to browser)
export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Browser-safe client (uses anon key)
export function createBrowserClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

export type Analysis = {
  id: string
  ticker: string
  timeframe: string
  created_at: string
  price: number | null
  price_change: number | null
  volume: number | null
  gemini_news: GeminiNewsResult | null
  claude_analysis: ClaudeAnalysisResult | null
  gpt_validation: GptValidationResult | null
  judge_verdict: JudgeVerdictResult | null
  final_signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null
  final_confidence: number | null
  final_target: string | null
  final_risk: string | null
  rounds_taken: number
  transcript: TranscriptMessage[]
}

export type GeminiNewsResult = {
  summary: string
  headlines: string[]
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed'
  confidence: number
  keyEvents: string[]
}

export type ClaudeAnalysisResult = {
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  reasoning: string
  target: string
  confidence: number
  technicals: string
  catalysts: string[]
}

export type GptValidationResult = {
  agrees: boolean
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  reasoning: string
  confidence: number
  challenges: string[]
}

export type JudgeVerdictResult = {
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  target: string
  risk: string
  summary: string
  rounds: number
  winningArgument: string
}

export type TranscriptMessage = {
  role: 'gemini' | 'claude' | 'gpt' | 'judge'
  stage: string
  content: string
  signal?: string
  confidence?: number
  timestamp: string
}
