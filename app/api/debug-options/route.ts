import { NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'

export async function GET() {
  const geminiKey = process.env.GEMINI_API_KEY
  const results: Record<string, unknown> = {
    geminiKeyPresent: !!geminiKey,
    geminiKeyLength: geminiKey?.length ?? 0,
  }

  if (!geminiKey) {
    return NextResponse.json({ error: 'No GEMINI_API_KEY', results })
  }

  try {
    const genAI = new GoogleGenerativeAI(geminiKey)
    
    // Test 1: basic call without tools
    const basicModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
    const basicResult = await basicModel.generateContent('Say OK')
    results.basicCall = basicResult.response.text()

    // Test 2: with googleSearch tool
    const searchModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} } as never],
    })
    const searchResult = await searchModel.generateContent(
      'Search for PEP PepsiCo put options expiring May 2025 on Yahoo Finance. Return the strike prices and premiums you find as plain text.'
    )
    results.searchCall = searchResult.response.text().slice(0, 1000)
    results.groundingMetadata = ((searchResult.response.candidates?.[0] as unknown) as Record<string, unknown>)?.groundingMetadata ?? null

  } catch (e: unknown) {
    results.error = e instanceof Error ? e.message : String(e)
    results.errorStack = e instanceof Error ? e.stack?.slice(0, 500) : null
  }

  return NextResponse.json(results)
}
