export interface TokenData {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

export interface GmailMessageHeader {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  labelIds: string[];
}

export interface GmailAttachment {
  filename: string;
  attachmentId: string;
  mimeType: string;
  sizeBytes?: number;
  partId?: string;
  inline?: boolean;
}

export interface GmailMessageFull {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  body: string;
  bodyOrigin?: 'text/plain' | 'text/html';
  bodyTruncated?: boolean;
  bodyTotalChars?: number;
  messageIdHeader?: string;
  inReplyTo?: string;
  references?: string;
  labelIds?: string[];
  internalDate?: string;
  attachments: GmailAttachment[];
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink: string;
  size: string;
}
