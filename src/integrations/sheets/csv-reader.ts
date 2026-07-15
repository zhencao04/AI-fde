import * as fs from 'fs';
import { BaseIntegration } from '../base';
import type { ConnectionConfig, IntegrationInfo, ToolDefinition, ToolCall, SheetData } from '../types';
import { registerIntegration } from '../registry';

export class CsvReader extends BaseIntegration {
  static getType(): 'sheets' {
    return 'sheets';
  }

  static getProvider(): string {
    return 'csv';
  }

  static getDefaultConfig(): Record<string, unknown> {
    return {
      delimiter: ',',
      encoding: 'utf-8',
    };
  }

  private delimiter: string;
  private encoding: BufferEncoding;

  constructor(connectionConfig: ConnectionConfig) {
    super(connectionConfig);
    this.delimiter = String(connectionConfig.config.delimiter || ',');
    this.encoding = (connectionConfig.config.encoding as BufferEncoding) || 'utf-8';
  }

  getInfo(): IntegrationInfo {
    return {
      id: this.config.id,
      type: 'sheets',
      provider: 'csv',
      name: 'CSV 读取器',
      description: 'CSV 文件读取器，支持自定义分隔符和编码，支持行列过滤',
      tools: this.getTools(),
    };
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'readFile',
        description: '读取 CSV 文件',
        parameters: [
          { name: 'filePath', type: 'string', required: true, description: '文件路径' },
          { name: 'startRow', type: 'number', required: false, description: '起始行索引，从0开始，默认0（表头行）' },
          { name: 'endRow', type: 'number', required: false, description: '结束行索引（不包含）' },
          { name: 'columns', type: 'array', required: false, description: '要读取的列名数组' },
          { name: 'delimiter', type: 'string', required: false, description: '分隔符，默认逗号' },
        ],
      },
      {
        name: 'readFromBuffer',
        description: '从 Buffer 读取 CSV 数据',
        parameters: [
          { name: 'buffer', type: 'object', required: true, description: '文件 Buffer' },
          { name: 'startRow', type: 'number', required: false, description: '起始行索引' },
          { name: 'endRow', type: 'number', required: false, description: '结束行索引' },
          { name: 'columns', type: 'array', required: false, description: '要读取的列名数组' },
          { name: 'delimiter', type: 'string', required: false, description: '分隔符' },
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
            typeof parameters.startRow === 'number' ? parameters.startRow : 0,
            typeof parameters.endRow === 'number' ? parameters.endRow : undefined,
            Array.isArray(parameters.columns) ? parameters.columns as string[] : undefined,
            typeof parameters.delimiter === 'string' ? parameters.delimiter : undefined,
          );
          break;
        case 'readFromBuffer':
          result = await this.readFromBuffer(
            parameters.buffer as Buffer,
            typeof parameters.startRow === 'number' ? parameters.startRow : 0,
            typeof parameters.endRow === 'number' ? parameters.endRow : undefined,
            Array.isArray(parameters.columns) ? parameters.columns as string[] : undefined,
            typeof parameters.delimiter === 'string' ? parameters.delimiter : undefined,
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
    startRow: number = 0,
    endRow?: number,
    columns?: string[],
    delimiter?: string,
  ): Promise<SheetData> {
    if (this.isMockMode()) {
      return this.getMockData(columns);
    }

    const data = fs.readFileSync(filePath, this.encoding);
    return this.parseCsv(data, startRow, endRow, columns, delimiter);
  }

  async readFromBuffer(
    buffer: Buffer,
    startRow: number = 0,
    endRow?: number,
    columns?: string[],
    delimiter?: string,
  ): Promise<SheetData> {
    if (this.isMockMode()) {
      return this.getMockData(columns);
    }

    const data = buffer.toString(this.encoding);
    return this.parseCsv(data, startRow, endRow, columns, delimiter);
  }

  private parseCsv(
    data: string,
    startRow: number = 0,
    endRow?: number,
    columns?: string[],
    delimiter?: string,
  ): SheetData {
    const d = delimiter || this.delimiter;
    const lines = data.split(/\r?\n/).filter(line => line.trim() !== '');

    if (lines.length === 0) {
      return { headers: [], rows: [] };
    }

    const allHeaders = this.parseLine(lines[0], d);
    const headers = columns ? columns.filter(c => allHeaders.includes(c)) : allHeaders;

    const dataLines = lines.slice(startRow + 1);
    const filteredLines = endRow !== undefined ? dataLines.slice(0, endRow - startRow - 1) : dataLines;

    const rows: Record<string, unknown>[] = filteredLines.map(line => {
      const values = this.parseLine(line, d);
      const rowObj: Record<string, unknown> = {};
      headers.forEach((header) => {
        const originalIndex = allHeaders.indexOf(header);
        rowObj[header] = originalIndex >= 0 ? this.parseValue(values[originalIndex]) : undefined;
      });
      return rowObj;
    });

    return { headers, rows };
  }

  private parseLine(line: string, delimiter: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuote && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (char === delimiter && !inQuote) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current);
    return result;
  }

  private parseValue(value: string): unknown {
    if (value === '') return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (!isNaN(Number(value))) return Number(value);
    return value;
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
    return { ok: true, message: 'CSV 读取器无需连接测试' };
  }
}

registerIntegration(CsvReader);