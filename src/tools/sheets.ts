import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';

const accountEnum = z.enum(ACCOUNTS);

export function registerSheetsTools(server: McpServer): void {
  // sheets_create
  server.registerTool(
    'sheets_create',
    {
      description: 'Create a new Google Sheets spreadsheet',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        title: z.string().describe('Spreadsheet title'),
        sheetTitles: z.array(z.string()).optional()
          .describe('Optional tab/sheet names (default: one sheet named "Sheet1")'),
      },
    },
    async ({ account, title, sheetTitles }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });

        const requestBody: any = {
          properties: { title },
        };

        if (sheetTitles && sheetTitles.length > 0) {
          requestBody.sheets = sheetTitles.map((t, i) => ({
            properties: { title: t, index: i },
          }));
        }

        const res = await sheets.spreadsheets.create({ requestBody });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            spreadsheetId: res.data.spreadsheetId,
            title: res.data.properties?.title,
            url: res.data.spreadsheetUrl,
            sheets: (res.data.sheets ?? []).map((s) => s.properties?.title),
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // sheets_get
  server.registerTool(
    'sheets_get',
    {
      description: 'Get spreadsheet metadata (title, sheets/tabs, named ranges)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
      },
    },
    async ({ account, spreadsheetId }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.get({
          spreadsheetId,
          fields: 'spreadsheetId,properties,sheets.properties,namedRanges,spreadsheetUrl',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            spreadsheetId: res.data.spreadsheetId,
            title: res.data.properties?.title,
            url: res.data.spreadsheetUrl,
            sheets: (res.data.sheets ?? []).map((s) => ({
              sheetId: s.properties?.sheetId,
              title: s.properties?.title,
              rowCount: s.properties?.gridProperties?.rowCount,
              columnCount: s.properties?.gridProperties?.columnCount,
            })),
            namedRanges: res.data.namedRanges ?? [],
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // sheets_read_range
  server.registerTool(
    'sheets_read_range',
    {
      description: 'Read cell values from a spreadsheet range (A1 notation, e.g. "Sheet1!A1:D10")',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: z.string().describe('A1 notation range, e.g. "Sheet1!A1:D10" or "A1:B5"'),
        valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'])
          .default('FORMATTED_VALUE').optional()
          .describe('How to render values (default: FORMATTED_VALUE)'),
      },
    },
    async ({ account, spreadsheetId, range, valueRenderOption }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range,
          valueRenderOption: valueRenderOption ?? 'FORMATTED_VALUE',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            range: res.data.range,
            values: res.data.values ?? [],
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // sheets_write_range
  server.registerTool(
    'sheets_write_range',
    {
      description: 'Write values to a spreadsheet range',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: z.string().describe('A1 notation target range, e.g. "Sheet1!A1:C3"'),
        values: z.array(z.array(z.any())).describe('2D array of values (rows x columns)'),
        valueInputOption: z.enum(['RAW', 'USER_ENTERED']).default('USER_ENTERED').optional()
          .describe('How to interpret values: RAW (literal) or USER_ENTERED (formulas/dates parsed). Default: USER_ENTERED'),
      },
    },
    async ({ account, spreadsheetId, range, values, valueInputOption }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.update({
          spreadsheetId,
          range,
          valueInputOption: valueInputOption ?? 'USER_ENTERED',
          requestBody: { values },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            updatedRange: res.data.updatedRange,
            updatedRows: res.data.updatedRows,
            updatedColumns: res.data.updatedColumns,
            updatedCells: res.data.updatedCells,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // sheets_append_rows
  server.registerTool(
    'sheets_append_rows',
    {
      description: 'Append rows after the last row of existing data in a spreadsheet',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: z.string().describe('A1 notation range to search for the table (e.g. "Sheet1")'),
        values: z.array(z.array(z.any())).describe('2D array of rows to append'),
        valueInputOption: z.enum(['RAW', 'USER_ENTERED']).default('USER_ENTERED').optional()
          .describe('How to interpret values. Default: USER_ENTERED'),
      },
    },
    async ({ account, spreadsheetId, range, values, valueInputOption }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.append({
          spreadsheetId,
          range,
          valueInputOption: valueInputOption ?? 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            tableRange: res.data.tableRange,
            updatedRange: res.data.updates?.updatedRange,
            updatedRows: res.data.updates?.updatedRows,
            updatedCells: res.data.updates?.updatedCells,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // sheets_clear_range
  server.registerTool(
    'sheets_clear_range',
    {
      description: 'Clear values from a range (keeps formatting intact)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: z.string().describe('A1 notation range to clear, e.g. "Sheet1!A1:D10"'),
      },
    },
    async ({ account, spreadsheetId, range }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.clear({
          spreadsheetId,
          range,
          requestBody: {},
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            clearedRange: res.data.clearedRange,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // sheets_batch_read
  server.registerTool(
    'sheets_batch_read',
    {
      description: 'Read multiple ranges from a spreadsheet in one request',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        ranges: z.array(z.string()).describe('Array of A1 notation ranges'),
        valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'])
          .default('FORMATTED_VALUE').optional()
          .describe('How to render values. Default: FORMATTED_VALUE'),
      },
    },
    async ({ account, spreadsheetId, ranges, valueRenderOption }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.batchGet({
          spreadsheetId,
          ranges,
          valueRenderOption: valueRenderOption ?? 'FORMATTED_VALUE',
        });
        const result = (res.data.valueRanges ?? []).map((vr) => ({
          range: vr.range,
          values: vr.values ?? [],
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // sheets_batch_write
  server.registerTool(
    'sheets_batch_write',
    {
      description: 'Write to multiple ranges in a spreadsheet in one request',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        data: z.array(z.object({
          range: z.string().describe('A1 notation range'),
          values: z.array(z.array(z.any())).describe('2D array of values'),
        })).describe('Array of { range, values } objects to write'),
        valueInputOption: z.enum(['RAW', 'USER_ENTERED']).default('USER_ENTERED').optional()
          .describe('How to interpret values. Default: USER_ENTERED'),
      },
    },
    async ({ account, spreadsheetId, data, valueInputOption }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: valueInputOption ?? 'USER_ENTERED',
            data,
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            totalUpdatedRows: res.data.totalUpdatedRows,
            totalUpdatedColumns: res.data.totalUpdatedColumns,
            totalUpdatedCells: res.data.totalUpdatedCells,
            totalUpdatedSheets: res.data.totalUpdatedSheets,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // sheets_add_sheet
  server.registerTool(
    'sheets_add_sheet',
    {
      description: 'Add a new tab/sheet to an existing spreadsheet',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        title: z.string().describe('Name for the new sheet/tab'),
        rowCount: z.number().min(1).default(1000).optional()
          .describe('Number of rows (default: 1000)'),
        columnCount: z.number().min(1).default(26).optional()
          .describe('Number of columns (default: 26)'),
      },
    },
    async ({ account, spreadsheetId, title, rowCount, columnCount }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              addSheet: {
                properties: {
                  title,
                  gridProperties: {
                    rowCount: rowCount ?? 1000,
                    columnCount: columnCount ?? 26,
                  },
                },
              },
            }],
          },
        });
        const added = res.data.replies?.[0]?.addSheet?.properties;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            sheetId: added?.sheetId,
            title: added?.title,
            rowCount: added?.gridProperties?.rowCount,
            columnCount: added?.gridProperties?.columnCount,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );
}

function handleSheetsError(error: any, account: Account) {
  if (error.code === 401) {
    return {
      content: [{
        type: 'text' as const,
        text: `Authentication error for account "${account}". Run: node dist/index.js auth --account ${account}`,
      }],
      isError: true,
    };
  }
  if (error.code === 429) {
    const retryAfter = error.response?.headers?.['retry-after'] ?? 'unknown';
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'rate_limited', retryAfter }),
      }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: error.message ?? String(error), code: error.code }),
    }],
    isError: true,
  };
}
