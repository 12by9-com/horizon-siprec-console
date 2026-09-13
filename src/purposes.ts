// The consent vocabulary, in one place.
//
// The same four purposes are named in the agreement text, stored as columns in
// the registry, listed in every receipt, and shown in three different places in
// this app. Defining the wording once keeps those from drifting apart — and in
// particular keeps the descriptions shown beside a checkbox identical to the
// descriptions in the agreement the receipt binds to.
//
// The description wording is deliberately the same as the data-subject
// portal's. Someone who sets consent here and later reads their receipt, or
// follows an emailed portal link, should not be shown two different accounts of
// what they agreed to.

export const PURPOSE_LABELS: Record<string, string> = {
  recording: 'Recording',
  transcription: 'Transcription',
  analysis: 'Analysis',
  ai_training: 'AI training',
};

export const PURPOSE_DESCRIPTIONS: Record<string, string> = {
  recording: 'capture and retention of the conversation audio',
  transcription: 'conversion of the audio to text',
  analysis: 'quality, compliance, and business analysis',
  ai_training: 'use of the conversation to improve automated systems',
};

// How the consent was obtained. 'attested' is a bare assertion with no evidence
// attached — worth showing as such rather than dressing it up.
export const PROOF_LABELS: Record<string, string> = {
  attested: 'Asserted, no evidence',
  a_priori_agreement: 'Prior agreement',
  announcement: 'Call announcement',
  dtmf: 'DTMF confirmation',
  verbal: 'Verbal confirmation',
  portal_receipt: 'Signed receipt',
};

export const purposeLabel = (p: string) => PURPOSE_LABELS[p] || p;
