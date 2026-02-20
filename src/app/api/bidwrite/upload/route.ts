import { NextRequest, NextResponse } from 'next/server';
import { callClaude, estimateTokens } from '@/lib/claude';

// @ts-ignore - pdf-parse doesn't have types
const pdf = require('pdf-parse');

const BUBBLE_API_URL = 'https://bidenginev1.bubbleapps.io/version-test/api/1.1/obj';
const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY || '33cb561a966f59ad7ea5e29a1906bf36';

// Extract text from PDF
async function extractPdfText(base64: string): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  const data = await pdf(buffer);
  return data.text;
}

// Use Claude to extract questions from document text
async function extractQuestions(text: string): Promise<any[]> {
  console.log('extractQuestions called, text length:', text?.length || 0);
  
  if (!text || text.trim().length < 50) {
    console.error('Text too short or empty:', text?.substring(0, 100));
    return [];
  }
  
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set');
    return [];
  }
  
  console.log('Calling Claude to extract questions...');
  
  const prompt = `You are an expert at extracting scoreable tender questions from UK public sector procurement documents.

Your job is to find every question or method statement that requires a written response and will be evaluated/scored.

DOCUMENT FORMATS YOU MUST RECOGNISE:
1. Direct questions: "Q1: Describe your approach to..."
2. Method statements: "MS1", "Method Statement 1", "Please provide a method statement..."
3. Instructional prompts: "The response must address:", "Tenderer's must describe:", "The response should include:"
4. "Not limited to" prompts: "Your response shall include, but is not limited to..." (these signal the evaluator wants MORE than the bullet points)
5. Numbered requirements with response fields: sections followed by "Your response" or "Your Response" or "Response"

WHAT TO EXTRACT:
- Any item that has a word limit, weighting, or scoring matrix = it's a scoreable question
- Method statements (MS1, MS2, etc.) are ALWAYS scoreable questions
- Items with "Your response" or "Response" fields after them

WHAT TO SKIP:
- Pass/Fail yes/no compliance questions (e.g., "Do you accept the terms?" Yes/No)
- Information-only questions that explicitly state "for information only" or "do not form part of the evaluation"
- Table of contents entries
- Response guidance/instructions

CRITICAL: question_text must contain the COMPLETE question content including:
- The main question/description text
- ALL bullet points and sub-requirements listed under "The response must address:" or "Tenderer's must describe:" or similar
- Any "not limited to" items
- Combine the title, description, AND all sub-points into one comprehensive question_text
- This should typically be 50-500 words, NOT just a title

Return a JSON array with objects containing:
- question_number: string (e.g., "1.1", "2.1", "3.1.1", "MS1")
- question_text: string (the COMPLETE question including ALL sub-requirements and bullet points)
- section: string (the section name, e.g., "Strategic Fit", "Delivery", "Operation")
- word_limit: number or null (if specified, e.g., 2000, 1500, 1000)
- weighting: string or null (if specified, e.g., "5%", "8%", "3%")
- method_statement_id: string or null (e.g., "MS1", "MS7", "MS14" if identified)

IMPORTANT CHECKS:
- If question_text is less than 20 words, you've only captured the title. Go back and include ALL the description and sub-requirements.
- If you find fewer than 5 scoreable questions in a document with method statements, you've missed some. Re-examine the document.
- Look for ALL sections - documents often have 4+ sections with multiple questions each.

Only return the JSON array, no other text.

Extract all scoreable tender questions from this document:

${text.substring(0, 50000)}`;

  const message = await callClaude(
    [{ role: 'user', content: prompt }],
    { 
      maxTokens: 8000,
      estimatedInputTokens: estimateTokens(prompt)
    }
  );

  const content = message.content[0];
  let responseText = '';
  if (content.type === 'text') {
    responseText = content.text;
  }
  
  console.log('Claude returned content:', responseText.substring(0, 500));
  
  // Parse JSON from response (handle markdown code blocks)
  let jsonStr = responseText;
  if (responseText.includes('```')) {
    jsonStr = responseText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  }
  
  try {
    const questions = JSON.parse(jsonStr);
    console.log('Parsed questions count:', questions.length);
    return questions;
  } catch (e) {
    console.error('Failed to parse questions JSON:', responseText);
    return [];
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      clientId,
      tenderId,
      tenderName,
      sector,
      fileName,
      fileType,
      fileBase64,
      extractedText 
    } = body;

    console.log('Upload API called:', {
      clientId,
      tenderId,
      tenderName,
      fileName,
      fileType,
      hasFileBase64: !!fileBase64,
      extractedTextLength: extractedText?.length || 0
    });

    if (!clientId) {
      return NextResponse.json({ error: 'Missing clientId' }, { status: 400 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not found in environment');
      return NextResponse.json({ error: 'Anthropic API key not configured' }, { status: 500 });
    }

    // Get document text
    let documentText = extractedText;
    if (!documentText && fileBase64) {
      console.log('Extracting text from PDF...');
      documentText = await extractPdfText(fileBase64);
    }
    
    console.log('Document text length:', documentText?.length || 0);
    console.log('Document text preview:', documentText?.substring(0, 200));

    if (!documentText) {
      return NextResponse.json({ error: 'No document text provided' }, { status: 400 });
    }

    // Extract questions using AI
    const questions = await extractQuestions(documentText);
    
    console.log('Questions extracted:', questions.length);
    console.log('Questions:', JSON.stringify(questions).substring(0, 500));

    if (questions.length === 0) {
      return NextResponse.json({ 
        error: 'No questions found in document',
        documentTextLength: documentText.length,
        documentPreview: documentText.substring(0, 300)
      }, { status: 400 });
    }

    // Use existing tenderId if provided, otherwise create new tender
    let finalTenderId = tenderId;
    
    if (!finalTenderId) {
      // Create tender in Bubble
      const tenderResponse = await fetch(`${BUBBLE_API_URL}/Tenders%20Data%20Type`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BUBBLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tender_name: tenderName || 'Untitled Tender',
          client: clientId,
          source_file: fileName,
          status: 'processing',
          question_count: questions.length,
          sector: sector || '',
        }),
      });

      if (!tenderResponse.ok) {
        const error = await tenderResponse.text();
        console.error('Failed to create tender:', error);
        return NextResponse.json({ error: 'Failed to create tender' }, { status: 500 });
      }

      const tenderData = await tenderResponse.json();
      finalTenderId = tenderData.id;
    } else {
      // Update existing tender with question count
      await fetch(`${BUBBLE_API_URL}/Tenders%20Data%20Type/${finalTenderId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${BUBBLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source_file: fileName,
          status: 'processing',
          question_count: questions.length,
          sector: sector || '',
        }),
      });
    }

    // Create questions in Bubble
    const questionResults = [];
    console.log('Creating', questions.length, 'questions in Bubble...');
    
    for (const q of questions) {
      console.log('Creating question:', q.question_number);
      
      const questionResponse = await fetch(`${BUBBLE_API_URL}/tender_questions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BUBBLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          question_number: String(q.question_number),
          question_text: q.question_text,
          section: q.section || 'General',
          tender: finalTenderId,
          client: clientId,
          status: 'pending',
        }),
      });

      if (questionResponse.ok) {
        const qData = await questionResponse.json();
        console.log('Question created:', qData.id);
        questionResults.push({
          _id: qData.id,
          question_number: q.question_number,
          question_text: q.question_text,
        });
      } else {
        const errorText = await questionResponse.text();
        console.error('Failed to create question:', q.question_number, questionResponse.status, errorText);
      }
    }

    return NextResponse.json({
      success: true,
      tender_id: finalTenderId,
      tender_name: tenderName,
      questions_created: questionResults.length,
      questions: questionResults,
    });

  } catch (error: any) {
    console.error('Upload error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
