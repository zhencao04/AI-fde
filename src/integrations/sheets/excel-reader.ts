import * as XLSX from 'xlsx';
import { BaseIntegration } from '../base';
import type { IntegrationInfo, ToolDefinition, ToolCall, SheetData } from '../types';
import { registerIntegration } from '../registry';

export class ExcelReader extends BaseIntegration {
  static getType(): 'sheets' {
    return 'sheets';
  }

  static getProvider(): string {
    return 'excel';
  }

  static getDefaultConfig(): Record<string, unknown> {
    return {};
  }

  getInfo(): IntegrationInfo {
    return {
      id: this.config.id,
      type: 'sheets',
      provider: 'excel',
      name: 'Excel 读取器',
      description: 'Excel 文件读取器，支持 .xlsx/.xls 格式，支持工作表选择和行列过滤',
      tools: this.getTools(),
    };
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'readFile',
        description: '读取 Excel 文件',
        parameters: [
          { name: 'filePath', type: 'string', required: true, description: '文件路径' },
          { name: 'sheetName', type: 'string', required: false, description: '工作表名称，默认读取第一个' },
          { name: 'sheetIndex', type: 'number', required: false, description: '工作表索引，从0开始' },
          { name: 'startRow', type: 'number', required: false, description: '起始行索引，从0开始，默认0（表头行）' },
          { name: 'endRow', type: 'number', required: false, description: '结束行索引（不包含）' },
          { name: 'columns', type: 'array', required: false, description: '要读取的列名数组，如 ["姓名", "邮箱"]' },
        ],
      },
      {
        name: 'listSheets',
        description: '列出 Excel 文件中的所有工作表',
        parameters: [
          { name: 'filePath', type: 'string', required: true, description: '文件路径' },
        ],
      },
      {
        name: 'readFromBuffer',
        description: '从 Buffer 读取 Excel 数据',
        parameters: [
          { name: 'buffer', type: 'object', required: true, description: '文件 Buffer' },
          { name: 'sheetName', type: 'string', required: false, description: '工作表名称' },
          { name: 'sheetIndex', type: 'number', required: false, description: '工作表索引' },
          { name: 'startRow', type: 'number', required: false, description: '起始行索引' },
          { name: 'endRow', type: 'number', required: false, description: '结束行索引' },
          { name: 'columns', type: 'array', required: false, description: '要读取的列名数组' },
        ],
      },
    ];
  }

  async executeTool(toolName: string, parameters: Record<string, unknown>): Promise<ToolCall> {
    try {
      let result: unknown;

      switch (toolName) {
        case 'readFile':
          result = await this.readFile(
            String(parameters.filePath || ''),
            typeof parameters.sheetName === 'string' ? parameters.sheetName : undefined,
            typeof parameters.sheetIndex === 'number' ? parameters.sheetIndex : undefined,
            typeof parameters.startRow === 'number' ? parameters.startRow : 0,
            typeof parameters.endRow === 'number' ? parameters.endRow : undefined,
            Array.isArray(parameters.columns) ? parameters.columns as string[] : undefined,
          );
          break;
        case 'listSheets':
          result = await this.listSheets(String(parameters.filePath || ''));
          break;
        case 'readFromBuffer':
          result = await this.readFromBuffer(
            parameters.buffer as Buffer,
            typeof parameters.sheetName === 'string' ? parameters.sheetName : undefined,
            typeof parameters.sheetIndex === 'number' ? parameters.sheetIndex : undefined,
            typeof parameters.startRow === 'number' ? parameters.startRow : 0,
            typeof parameters.endRow === 'number' ? parameters.endRow : undefined,
            Array.isArray(parameters.columns) ? parameters.columns as string[] : undefined,
          );
          break;
        default:
          return this.createToolCall(toolName, parameters, 'failed', undefined, `未知工具: ${toolName}`);
      }

      return this.createToolCall(toolName, parameters, 'success', result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return this.createToolCall(toolName, parameters, 'failed', undefined, error);
    }
  }

  async readFile(
    filePath: string,
    sheetName?: string,
    sheetIndex?: number,
    startRow: number = 0,
    endRow?: number,
    columns?: string[],
  ): Promise<SheetData> {
    if (this.isMockMode()) {
      return this.getMockData(columns);
    }

    const workbook = XLSX.readFile(filePath);
    return this.extractSheetData(workbook, sheetName, sheetIndex, startRow, endRow, columns);
  }

  async readFromBuffer(
    buffer: Buffer,
    sheetName?: string,
    sheetIndex?: number,
    startRow: number = 0,
    endRow?: number,
    columns?: string[],
  ): Promise<SheetData> {
    if (this.isMockMode()) {
      return this.getMockData(columns);
    }

    const workbook = XLSX.read(buffer);
    return this.extractSheetData(workbook, sheetName, sheetIndex, startRow, endRow, columns);
  }

  async listSheets(filePath: string): Promise<string[]> {
    if (this.isMockMode()) {
      return ['员工列表', '销售数据', '产品目录'];
    }

    const workbook = XLSX.readFile(filePath);
    return workbook.SheetNames;
  }

  private extractSheetData(
    workbook: XLSX.WorkBook,
    sheetName?: string,
    sheetIndex?: number,
    startRow: number = 0,
    endRow?: number,
    columns?: string[],
  ): SheetData {
    let targetSheet: XLSX.WorkSheet | undefined;

    if (sheetName) {
      targetSheet = workbook.Sheets[sheetName];
    } else if (sheetIndex !== undefined) {
      targetSheet = workbook.Sheets[workbook.SheetNames[sheetIndex]];
    } else {
      targetSheet = workbook.Sheets[workbook.SheetNames[0]];
    }

    if (!targetSheet) {
      throw new Error('工作表不存在');
    }

    const jsonData = XLSX.utils.sheet_to_json(targetSheet, { header: 1 });
    const allHeaders = (jsonData[0] as string[]) || [];
    const headers = columns ? columns.filter(c => allHeaders.includes(c)) : allHeaders;

    const dataRows = jsonData.slice(startRow + 1);
    const filteredRows = endRow !== undefined ? dataRows.slice(0, endRow - startRow - 1) : dataRows;

    const rows: Record<string, unknown>[] = filteredRows.map(row => {
      const rowObj: Record<string, unknown> = {};
      headers.forEach((header) => {
        const originalIndex = allHeaders.indexOf(header);
        rowObj[header] = originalIndex >= 0 ? (row as unknown[])[originalIndex] : undefined;
      });
      return rowObj;
    });

    return { headers, rows };
  }

  private getMockData(columns?: string[]): SheetData {
    const defaultHeaders = ['姓名', '邮箱', '部门', '入职日期', '薪资'];
    const headers = columns && columns.length > 0 ? columns : defaultHeaders;

    const allData = [
      { '姓名': '张三', '邮箱': 'zhangsan@example.com', '部门': '技术部', '入职日期': '2022-01-15', '薪资': 15000 },
      { '姓名': '李四', '邮箱': 'lisi@example.com', '部门': '市场部', '入职日期': '2022-03-20', '薪资': 12000 },
      { '姓名': '王五', '邮箱': 'wangwu@example.com', '部门': '销售部', '入职日期': '2023-01-10', '薪资': 18000 },
      { '姓名': '赵六', '邮箱': 'zhaoliu@example.com', '部门': '人事部', '入职日期': '2023-06-01', '薪资': 10000 },
      { '姓名': '钱七', '邮箱': 'qianqi@example.com', '部门': '财务部', '入职日期': '2024-01-15', '薪资': 13000 },
    ];

    const rows = allData.map(row => {
      const filtered: Record<string, unknown> = {};
      headers.forEach(h => {
        filtered[h] = row[h as keyof typeof row];
      });
      return filtered;
    });

    return { headers, rows };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string; error?: string }> {
    return { ok: true, message: 'Excel 读取器无需连接测试' };
  }
}

registerIntegration(ExcelReader);