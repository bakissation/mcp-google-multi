import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';
import { stringToArray } from './_coerce.js';

const accountEnum = z.enum(ACCOUNTS);

export function registerSheetsTools(server: McpServer): void {
  server.registerTool(
    'sheets_create',
    {
      description: 'Create a new Google Sheets spreadsheet',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        title: z.string().describe('Spreadsheet title'),
        sheetTitles: z.unknown().pipe(stringToArray).optional()
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

  server.registerTool(
    'sheets_batch_read',
    {
      description: 'Read multiple ranges from a spreadsheet in one request',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        ranges: z.unknown().pipe(stringToArray).describe('Array of A1 notation ranges'),
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

  // ─── Sheet ops ─────────────────────────────────────────────────────────

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

  server.registerTool(
    'sheets_delete_sheet',
    {
      description: 'Delete a tab/sheet from a spreadsheet by sheetId',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        sheetId: z.number().describe('Sheet ID (integer, from sheets_get)'),
      },
    },
    async ({ account, spreadsheetId, sheetId }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ deleteSheet: { sheetId } }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, sheetId }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_duplicate_sheet',
    {
      description: 'Duplicate a tab within the same spreadsheet',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        sourceSheetId: z.number().describe('Source sheet ID'),
        newSheetName: z.string().optional().describe('Name for the duplicate (default: "Copy of <source>")'),
        insertSheetIndex: z.number().optional().describe('Where to insert the duplicate (0-based)'),
      },
    },
    async ({ account, spreadsheetId, sourceSheetId, newSheetName, insertSheetIndex }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              duplicateSheet: {
                sourceSheetId,
                newSheetName,
                insertSheetIndex,
              },
            }],
          },
        });
        const props = res.data.replies?.[0]?.duplicateSheet?.properties;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(props ?? {}, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_update_sheet_properties',
    {
      description: 'Rename a tab, change tab color, freeze rows/columns, hide/show, or change grid dimensions',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        sheetId: z.number().describe('Sheet ID'),
        title: z.string().optional().describe('New tab title'),
        index: z.number().optional().describe('New position among tabs'),
        hidden: z.boolean().optional().describe('Hide the tab from the UI'),
        tabColor: rgbColorSchema.optional().describe('Tab color (RGB 0..1)'),
        frozenRowCount: z.number().min(0).optional().describe('Number of frozen header rows'),
        frozenColumnCount: z.number().min(0).optional().describe('Number of frozen header columns'),
        rowCount: z.number().min(1).optional().describe('Total row count'),
        columnCount: z.number().min(1).optional().describe('Total column count'),
      },
    },
    async ({ account, spreadsheetId, sheetId, title, index, hidden, tabColor, frozenRowCount, frozenColumnCount, rowCount, columnCount }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const properties: any = { sheetId };
        const fields: string[] = [];
        if (title !== undefined) { properties.title = title; fields.push('title'); }
        if (index !== undefined) { properties.index = index; fields.push('index'); }
        if (hidden !== undefined) { properties.hidden = hidden; fields.push('hidden'); }
        if (tabColor) {
          properties.tabColorStyle = { rgbColor: tabColor };
          fields.push('tabColorStyle');
        }
        const grid: any = {};
        const gridFields: string[] = [];
        if (frozenRowCount !== undefined) { grid.frozenRowCount = frozenRowCount; gridFields.push('frozenRowCount'); }
        if (frozenColumnCount !== undefined) { grid.frozenColumnCount = frozenColumnCount; gridFields.push('frozenColumnCount'); }
        if (rowCount !== undefined) { grid.rowCount = rowCount; gridFields.push('rowCount'); }
        if (columnCount !== undefined) { grid.columnCount = columnCount; gridFields.push('columnCount'); }
        if (gridFields.length > 0) {
          properties.gridProperties = grid;
          for (const f of gridFields) fields.push(`gridProperties.${f}`);
        }
        if (fields.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No properties supplied' }, null, 2) }],
            isError: true,
          };
        }

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              updateSheetProperties: {
                properties,
                fields: fields.join(','),
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ updated: true, sheetId, applied: fields }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // ─── Cell formatting ───────────────────────────────────────────────────

  server.registerTool(
    'sheets_format_cells',
    {
      description: 'Apply uniform formatting (colors, fonts, alignment, number format) to every cell in a range. Uses RepeatCell with a computed fields mask. For borders use sheets_update_borders.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: gridRangeSchema.describe('Target range (GridRange, half-open indexes)'),
        backgroundColor: rgbColorSchema.optional().describe('Cell background (RGB 0..1)'),
        textFormat: z.object({
          foregroundColor: rgbColorSchema.optional(),
          bold: z.boolean().optional(),
          italic: z.boolean().optional(),
          underline: z.boolean().optional(),
          strikethrough: z.boolean().optional(),
          fontFamily: z.string().optional(),
          fontSize: z.number().min(1).optional(),
        }).optional(),
        horizontalAlignment: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional(),
        verticalAlignment: z.enum(['TOP', 'MIDDLE', 'BOTTOM']).optional(),
        wrapStrategy: z.enum(['OVERFLOW_CELL', 'LEGACY_WRAP', 'CLIP', 'WRAP']).optional(),
        numberFormat: z.object({
          type: z.enum(['TEXT', 'NUMBER', 'PERCENT', 'CURRENCY', 'DATE', 'TIME', 'DATE_TIME', 'SCIENTIFIC']),
          pattern: z.string().optional().describe('Optional format string (e.g. "$#,##0.00")'),
        }).optional(),
      },
    },
    async ({ account, spreadsheetId, range, ...format }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const built = buildCellFormat(format);
        if (built.fields.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No format properties supplied' }, null, 2) }],
            isError: true,
          };
        }
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              repeatCell: {
                range,
                cell: { userEnteredFormat: built.format },
                fields: built.fields,
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ formatted: true, applied: built.fields }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_update_borders',
    {
      description: 'Set borders on a range. Each border specifies style and optional color.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: gridRangeSchema,
        top: borderSchema.optional(),
        bottom: borderSchema.optional(),
        left: borderSchema.optional(),
        right: borderSchema.optional(),
        innerHorizontal: borderSchema.optional(),
        innerVertical: borderSchema.optional(),
      },
    },
    async ({ account, spreadsheetId, range, top, bottom, left, right, innerHorizontal, innerVertical }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const borders: any = { range };
        if (top) borders.top = toBorder(top);
        if (bottom) borders.bottom = toBorder(bottom);
        if (left) borders.left = toBorder(left);
        if (right) borders.right = toBorder(right);
        if (innerHorizontal) borders.innerHorizontal = toBorder(innerHorizontal);
        if (innerVertical) borders.innerVertical = toBorder(innerVertical);
        if (Object.keys(borders).length === 1) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'At least one border edge must be supplied' }, null, 2) }],
            isError: true,
          };
        }
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ updateBorders: borders }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ borders_applied: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_merge_cells',
    {
      description: 'Merge a range of cells. MERGE_ALL collapses the range to one cell; MERGE_COLUMNS merges each column; MERGE_ROWS merges each row.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: gridRangeSchema,
        mergeType: z.enum(['MERGE_ALL', 'MERGE_COLUMNS', 'MERGE_ROWS']).default('MERGE_ALL').optional(),
      },
    },
    async ({ account, spreadsheetId, range, mergeType }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ mergeCells: { range, mergeType: mergeType ?? 'MERGE_ALL' } }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ merged: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_unmerge_cells',
    {
      description: 'Unmerge any merged cells overlapping the given range',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: gridRangeSchema,
      },
    },
    async ({ account, spreadsheetId, range }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ unmergeCells: { range } }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ unmerged: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // ─── Conditional formatting ────────────────────────────────────────────

  server.registerTool(
    'sheets_add_conditional_format_rule',
    {
      description: 'Add a conditional format rule. Specify either booleanRule (single trigger condition + format) or gradientRule (min/mid/max color stops).',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        ranges: z.array(gridRangeSchema).describe('Ranges the rule applies to'),
        index: z.number().min(0).optional().describe('Where in the rule order to insert (0 = highest priority)'),
        booleanRule: z.object({
          conditionType: z.string().describe(BOOLEAN_CONDITION_TYPE_DESC),
          conditionValues: z.unknown().pipe(stringToArray).optional().describe('Values for the condition (e.g. ["100"] for NUMBER_GREATER, or ["=A1>10"] for CUSTOM_FORMULA)'),
          format: z.object({
            backgroundColor: rgbColorSchema.optional(),
            textFormat: z.object({
              foregroundColor: rgbColorSchema.optional(),
              bold: z.boolean().optional(),
              italic: z.boolean().optional(),
              strikethrough: z.boolean().optional(),
              underline: z.boolean().optional(),
            }).optional(),
          }).describe('Format to apply when condition is true. Conditional formatting only supports bold/italic/strikethrough/underline/foregroundColor/backgroundColor.'),
        }).optional(),
        gradientRule: z.object({
          minpoint: gradientStopSchema,
          midpoint: gradientStopSchema.optional(),
          maxpoint: gradientStopSchema,
        }).optional(),
      },
    },
    async ({ account, spreadsheetId, ranges, index, booleanRule, gradientRule }) => {
      try {
        if (!booleanRule && !gradientRule) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either booleanRule or gradientRule must be supplied' }, null, 2) }],
            isError: true,
          };
        }
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });

        const rule: any = { ranges };
        if (booleanRule) {
          const fmt: any = {};
          if (booleanRule.format.backgroundColor) fmt.backgroundColorStyle = { rgbColor: booleanRule.format.backgroundColor };
          if (booleanRule.format.textFormat) {
            const tf: any = {};
            const t = booleanRule.format.textFormat;
            if (t.foregroundColor) tf.foregroundColorStyle = { rgbColor: t.foregroundColor };
            if (t.bold !== undefined) tf.bold = t.bold;
            if (t.italic !== undefined) tf.italic = t.italic;
            if (t.strikethrough !== undefined) tf.strikethrough = t.strikethrough;
            if (t.underline !== undefined) tf.underline = t.underline;
            fmt.textFormat = tf;
          }
          rule.booleanRule = {
            condition: {
              type: booleanRule.conditionType,
              values: (booleanRule.conditionValues ?? []).map(v => ({ userEnteredValue: v })),
            },
            format: fmt,
          };
        }
        if (gradientRule) {
          rule.gradientRule = {
            minpoint: toGradientStop(gradientRule.minpoint),
            midpoint: gradientRule.midpoint ? toGradientStop(gradientRule.midpoint) : undefined,
            maxpoint: toGradientStop(gradientRule.maxpoint),
          };
        }

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              addConditionalFormatRule: { rule, index: index ?? 0 },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ added: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // ─── Filter / sort / find-replace ──────────────────────────────────────

  server.registerTool(
    'sheets_sort_range',
    {
      description: 'Sort a range by one or more columns',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: gridRangeSchema,
        sortSpecs: z.array(sortSpecSchema).describe('One spec per sort column (in priority order)'),
      },
    },
    async ({ account, spreadsheetId, range, sortSpecs }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ sortRange: { range, sortSpecs } }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ sorted: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_set_basic_filter',
    {
      description: 'Apply a basic filter to a range. Optionally supply sortSpecs to set the default sort, and filterSpecs to hide rows based on per-column criteria.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: gridRangeSchema,
        sortSpecs: z.array(sortSpecSchema).optional(),
        filterSpecs: z.array(z.object({
          columnIndex: z.number().min(0),
          hiddenValues: z.unknown().pipe(stringToArray).optional().describe('Values to hide in this column'),
          conditionType: z.string().optional().describe(BOOLEAN_CONDITION_TYPE_DESC),
          conditionValues: z.unknown().pipe(stringToArray).optional(),
        })).optional(),
      },
    },
    async ({ account, spreadsheetId, range, sortSpecs, filterSpecs }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const filter: any = { range };
        if (sortSpecs) filter.sortSpecs = sortSpecs;
        if (filterSpecs) {
          filter.filterSpecs = filterSpecs.map(s => {
            const out: any = { columnIndex: s.columnIndex };
            const criteria: any = {};
            if (s.hiddenValues) criteria.hiddenValues = s.hiddenValues;
            if (s.conditionType) {
              criteria.condition = {
                type: s.conditionType,
                values: (s.conditionValues ?? []).map(v => ({ userEnteredValue: v })),
              };
            }
            out.filterCriteria = criteria;
            return out;
          });
        }
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ setBasicFilter: { filter } }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ filter_set: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_clear_basic_filter',
    {
      description: 'Remove the basic filter from a sheet',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        sheetId: z.number().describe('Sheet ID'),
      },
    },
    async ({ account, spreadsheetId, sheetId }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ clearBasicFilter: { sheetId } }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ cleared: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_find_replace',
    {
      description: 'Find and replace text across a range, a sheet, or all sheets. Supports case sensitivity, full-cell match, regex, and formula scope.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        find: z.string().describe('Text to find'),
        replacement: z.string().describe('Replacement text'),
        scope: z.enum(['allSheets', 'sheet', 'range']).describe('Search scope'),
        sheetId: z.number().optional().describe('Required when scope=sheet'),
        range: gridRangeSchema.optional().describe('Required when scope=range'),
        matchCase: z.boolean().optional(),
        matchEntireCell: z.boolean().optional(),
        searchByRegex: z.boolean().optional(),
        includeFormulas: z.boolean().optional(),
      },
    },
    async ({ account, spreadsheetId, find, replacement, scope, sheetId, range, matchCase, matchEntireCell, searchByRegex, includeFormulas }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const findReplace: any = {
          find,
          replacement,
          matchCase: matchCase ?? false,
          matchEntireCell: matchEntireCell ?? false,
          searchByRegex: searchByRegex ?? false,
          includeFormulas: includeFormulas ?? false,
        };
        if (scope === 'allSheets') findReplace.allSheets = true;
        else if (scope === 'sheet') {
          if (sheetId === undefined) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'sheetId required when scope=sheet' }) }], isError: true };
          }
          findReplace.sheetId = sheetId;
        } else {
          if (!range) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'range required when scope=range' }) }], isError: true };
          }
          findReplace.range = range;
        }
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ findReplace }] },
        });
        const reply = res.data.replies?.[0]?.findReplace;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            valuesChanged: reply?.valuesChanged ?? 0,
            occurrencesChanged: reply?.occurrencesChanged ?? 0,
            rowsChanged: reply?.rowsChanged ?? 0,
            sheetsChanged: reply?.sheetsChanged ?? 0,
            formulasChanged: reply?.formulasChanged ?? 0,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // ─── Dimensions ────────────────────────────────────────────────────────

  server.registerTool(
    'sheets_auto_resize_dimensions',
    {
      description: 'Auto-resize rows or columns to fit content',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        sheetId: z.number().describe('Sheet ID'),
        dimension: z.enum(['ROWS', 'COLUMNS']).describe('Which dimension to resize'),
        startIndex: z.number().min(0).optional(),
        endIndex: z.number().min(1).optional(),
      },
    },
    async ({ account, spreadsheetId, sheetId, dimension, startIndex, endIndex }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const dimensions: any = { sheetId, dimension };
        if (startIndex !== undefined) dimensions.startIndex = startIndex;
        if (endIndex !== undefined) dimensions.endIndex = endIndex;
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ autoResizeDimensions: { dimensions } }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ resized: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_insert_dimension',
    {
      description: 'Insert rows or columns at a position. inheritFromBefore=true copies properties from the row/column before the insertion point.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        sheetId: z.number().describe('Sheet ID'),
        dimension: z.enum(['ROWS', 'COLUMNS']),
        startIndex: z.number().min(0).describe('0-based, inclusive'),
        endIndex: z.number().min(1).describe('0-based, exclusive'),
        inheritFromBefore: z.boolean().optional(),
      },
    },
    async ({ account, spreadsheetId, sheetId, dimension, startIndex, endIndex, inheritFromBefore }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              insertDimension: {
                range: { sheetId, dimension, startIndex, endIndex },
                inheritFromBefore: inheritFromBefore ?? false,
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ inserted: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_delete_dimension',
    {
      description: 'Delete rows or columns from a sheet',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        sheetId: z.number().describe('Sheet ID'),
        dimension: z.enum(['ROWS', 'COLUMNS']),
        startIndex: z.number().min(0),
        endIndex: z.number().min(1),
      },
    },
    async ({ account, spreadsheetId, sheetId, dimension, startIndex, endIndex }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              deleteDimension: {
                range: { sheetId, dimension, startIndex, endIndex },
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // ─── Data validation ───────────────────────────────────────────────────

  server.registerTool(
    'sheets_set_data_validation',
    {
      description: 'Apply a data validation rule (dropdown, checkbox, numeric range, etc.) to a range. Pass conditionType=null to clear validation.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        range: gridRangeSchema,
        conditionType: z.string().describe(BOOLEAN_CONDITION_TYPE_DESC),
        conditionValues: z.unknown().pipe(stringToArray).optional().describe('Values per condition type (list items for ONE_OF_LIST, range A1 for ONE_OF_RANGE, etc.)'),
        inputMessage: z.string().optional().describe('Tooltip shown when cell is selected'),
        strict: z.boolean().optional().describe('Reject invalid input (default: false = warning only)'),
        showCustomUi: z.boolean().optional().describe('Show dropdown UI for list-type validations'),
      },
    },
    async ({ account, spreadsheetId, range, conditionType, conditionValues, inputMessage, strict, showCustomUi }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const rule: any = {
          condition: {
            type: conditionType,
            values: (conditionValues ?? []).map(v => ({ userEnteredValue: v })),
          },
          strict: strict ?? false,
        };
        if (inputMessage !== undefined) rule.inputMessage = inputMessage;
        if (showCustomUi !== undefined) rule.showCustomUi = showCustomUi;

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ setDataValidation: { range, rule } }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ validation_set: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // ─── Named ranges ──────────────────────────────────────────────────────

  server.registerTool(
    'sheets_add_named_range',
    {
      description: 'Define a named range so formulas can reference it by name',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        name: z.string().describe('Named range identifier (no spaces)'),
        range: gridRangeSchema,
      },
    },
    async ({ account, spreadsheetId, name, range }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ addNamedRange: { namedRange: { name, range } } }],
          },
        });
        const added = res.data.replies?.[0]?.addNamedRange?.namedRange;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(added ?? {}, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_delete_named_range',
    {
      description: 'Delete a named range by its ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        namedRangeId: z.string().describe('Named range ID (from sheets_get response)'),
      },
    },
    async ({ account, spreadsheetId, namedRangeId }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ deleteNamedRange: { namedRangeId } }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, namedRangeId }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  // ─── Values: batchClear + generic batchUpdate ──────────────────────────

  server.registerTool(
    'sheets_batch_clear',
    {
      description: 'Clear values from multiple ranges in one request',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        ranges: z.unknown().pipe(stringToArray).describe('Array of A1 notation ranges'),
      },
    },
    async ({ account, spreadsheetId, ranges }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.values.batchClear({
          spreadsheetId,
          requestBody: { ranges },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            clearedRanges: res.data.clearedRanges ?? [],
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'sheets_batch_update',
    {
      description: 'Generic spreadsheets.batchUpdate pass-through. Accepts the full Request union (~70 types). Use this for advanced operations not covered by a dedicated tool. See https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        spreadsheetId: z.string().describe('Spreadsheet ID'),
        requests: z.array(z.record(z.string(), z.any())).describe('Array of Request objects. Each object has exactly one key (the request type) like {repeatCell: {...}}, {addChart: {...}}, {updateBanding: {...}}, etc.'),
        includeSpreadsheetInResponse: z.boolean().optional(),
        responseRanges: z.unknown().pipe(stringToArray).optional(),
        responseIncludeGridData: z.boolean().optional(),
      },
    },
    async ({ account, spreadsheetId, requests, includeSpreadsheetInResponse, responseRanges, responseIncludeGridData }) => {
      try {
        const auth = await getClient(account as Account);
        const sheets = google.sheets({ version: 'v4', auth });
        const res = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: requests as any,
            includeSpreadsheetInResponse,
            responseRanges,
            responseIncludeGridData,
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            replies: res.data.replies ?? [],
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSheetsError(error, account as Account);
      }
    },
  );
}

// ─── Shared schemas & helpers ────────────────────────────────────────────

const rgbColorSchema = z.object({
  red: z.number().min(0).max(1).optional(),
  green: z.number().min(0).max(1).optional(),
  blue: z.number().min(0).max(1).optional(),
  alpha: z.number().min(0).max(1).optional(),
});

const sortSpecSchema = z.object({
  dimensionIndex: z.number().min(0).describe('Column index within the range (0-based)'),
  sortOrder: z.enum(['ASCENDING', 'DESCENDING']).default('ASCENDING'),
});

// BooleanCondition.type — kept open (z.string) because Google's enum surface is large and may grow.
const BOOLEAN_CONDITION_TYPE_DESC =
  'BooleanCondition.type. Common values: NUMBER_GREATER, NUMBER_BETWEEN, TEXT_CONTAINS, TEXT_EQ, DATE_BEFORE, BLANK, NOT_BLANK, CUSTOM_FORMULA, BOOLEAN, ONE_OF_LIST, ONE_OF_RANGE.';

const gridRangeSchema = z.object({
  sheetId: z.number().describe('Sheet ID'),
  startRowIndex: z.number().min(0).optional().describe('0-based, inclusive. Omit = from row 0.'),
  endRowIndex: z.number().min(0).optional().describe('0-based, exclusive. Omit = to last row.'),
  startColumnIndex: z.number().min(0).optional(),
  endColumnIndex: z.number().min(0).optional(),
});

const borderSchema = z.object({
  style: z.enum(['DOTTED', 'DASHED', 'SOLID', 'SOLID_MEDIUM', 'SOLID_THICK', 'NONE', 'DOUBLE']),
  color: rgbColorSchema.optional(),
});

const gradientStopSchema = z.object({
  type: z.enum(['MIN', 'MAX', 'NUMBER', 'PERCENT', 'PERCENTILE']),
  value: z.string().optional().describe('Required when type is NUMBER/PERCENT/PERCENTILE'),
  color: rgbColorSchema,
});

function toBorder(b: { style: string; color?: any }) {
  const out: any = { style: b.style };
  if (b.color) out.colorStyle = { rgbColor: b.color };
  return out;
}

function toGradientStop(s: { type: string; value?: string; color: any }) {
  const out: any = { type: s.type, colorStyle: { rgbColor: s.color } };
  if (s.value !== undefined) out.value = s.value;
  return out;
}

export function buildCellFormat(input: {
  backgroundColor?: { red?: number; green?: number; blue?: number; alpha?: number };
  textFormat?: {
    foregroundColor?: { red?: number; green?: number; blue?: number; alpha?: number };
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    fontFamily?: string;
    fontSize?: number;
  };
  horizontalAlignment?: string;
  verticalAlignment?: string;
  wrapStrategy?: string;
  numberFormat?: { type: string; pattern?: string };
}): { format: any; fields: string } {
  const format: any = {};
  const fields: string[] = [];

  if (input.backgroundColor) {
    format.backgroundColorStyle = { rgbColor: input.backgroundColor };
    fields.push('userEnteredFormat.backgroundColorStyle');
  }

  if (input.textFormat) {
    const tf: any = {};
    const t = input.textFormat;
    if (t.foregroundColor) { tf.foregroundColorStyle = { rgbColor: t.foregroundColor }; fields.push('userEnteredFormat.textFormat.foregroundColorStyle'); }
    if (t.bold !== undefined) { tf.bold = t.bold; fields.push('userEnteredFormat.textFormat.bold'); }
    if (t.italic !== undefined) { tf.italic = t.italic; fields.push('userEnteredFormat.textFormat.italic'); }
    if (t.underline !== undefined) { tf.underline = t.underline; fields.push('userEnteredFormat.textFormat.underline'); }
    if (t.strikethrough !== undefined) { tf.strikethrough = t.strikethrough; fields.push('userEnteredFormat.textFormat.strikethrough'); }
    if (t.fontFamily) { tf.fontFamily = t.fontFamily; fields.push('userEnteredFormat.textFormat.fontFamily'); }
    if (t.fontSize !== undefined) { tf.fontSize = t.fontSize; fields.push('userEnteredFormat.textFormat.fontSize'); }
    if (Object.keys(tf).length > 0) format.textFormat = tf;
  }

  if (input.horizontalAlignment) { format.horizontalAlignment = input.horizontalAlignment; fields.push('userEnteredFormat.horizontalAlignment'); }
  if (input.verticalAlignment) { format.verticalAlignment = input.verticalAlignment; fields.push('userEnteredFormat.verticalAlignment'); }
  if (input.wrapStrategy) { format.wrapStrategy = input.wrapStrategy; fields.push('userEnteredFormat.wrapStrategy'); }

  if (input.numberFormat) {
    format.numberFormat = { type: input.numberFormat.type, pattern: input.numberFormat.pattern };
    fields.push('userEnteredFormat.numberFormat');
  }

  return { format, fields: fields.join(',') };
}

function handleSheetsError(error: any, account: Account) {
  return handleGoogleApiError(error, account);
}
