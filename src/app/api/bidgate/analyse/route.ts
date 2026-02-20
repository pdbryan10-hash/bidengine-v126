import { NextRequest, NextResponse } from 'next/server';

const N8N_WEBHOOK_URL = process.env.BIDGATE_N8N_WEBHOOK_URL || 'https://bidengine.app.n8n.cloud/webhook/bidgate-analyse';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const clientId = formData.get('clientId') as string;
    const tenderName = formData.get('tenderName') as string;

    if (!file || !clientId) {
      return NextResponse.json({ error: 'Missing file or clientId' }, { status: 400 });
    }

    // Convert file to base64 and send to n8n for processing
    // n8n handles PDF extraction more reliably than serverless environments
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileBase64 = buffer.toString('base64');
    const fileName = file.name.toLowerCase();
    const fileType = fileName.endsWith('.pdf') ? 'pdf' : 
                     fileName.endsWith('.docx') ? 'docx' : 
                     fileName.endsWith('.doc') ? 'doc' : 'text';

    // For plain text files, extract directly
    let tenderText = '';
    if (fileType === 'text') {
      tenderText = buffer.toString('utf-8');
    }

    // Call n8n webhook with file data
    const n8nResponse = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: {
          clientId,
          tenderName: tenderName || file.name,
          fileName: file.name,
          fileType,
          fileBase64: fileType !== 'text' ? fileBase64 : undefined,
          tenderText: fileType === 'text' ? tenderText.substring(0, 50000) : undefined,
        }
      }),
    });

    if (!n8nResponse.ok) {
      const errorText = await n8nResponse.text();
      console.error('n8n error:', errorText);
      return NextResponse.json({ error: 'Analysis failed', details: errorText }, { status: 500 });
    }

    const result = await n8nResponse.json();

    // Handle both array and object responses from n8n
    const data = Array.isArray(result) ? result[0] : result;

    return NextResponse.json({
      success: data.success || true,
      analysis: data.analysis,
      tender_name: data.tender_name || tenderName || file.name,
      evidence_counts: data.evidence_counts,
      total_evidence: data.total_evidence,
    });

  } catch (error) {
    console.error('BidGate API error:', error);
    return NextResponse.json(
      { error: 'Failed to analyse tender', details: String(error) },
      { status: 500 }
    );
  }
}
