/**
 * Skill 内容摘要生成器
 * 
 * 从 Skill Markdown 内容中提取结构化信息，生成摘要
 * 摘要包含：API列表、参数、关键约束、依赖关系
 */

import crypto from 'crypto';

export interface APIDefinition {
  name: string;
  params: string[];
  returnType: string;
  keyNotes: string[];
  description?: string;
}

export interface SkillDigest {
  path: string;
  apis: APIDefinition[];
  keyConcepts: string[];
  dependencies: string[];
  importantNotes: string[];
  version?: string;
}

export interface DigestWithHash {
  digest: SkillDigest;
  fileHash: string;
  generatedAt: string;
}

/**
 * 生成 Skill 内容的结构化摘要
 */
export function generateDigest(content: string, path: string = ''): SkillDigest {
  const lines = content.split('\n');
  const apis: APIDefinition[] = [];
  const keyConcepts: string[] = [];
  const dependencies: string[] = [];
  const importantNotes: string[] = [];

  let currentSection = '';
  let inCodeBlock = false;
  let codeBlockContent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 检测代码块
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // 代码块结束，解析内容
        const api = parseCodeBlock(codeBlockContent, lines[i].replace('```', '').trim());
        if (api) {
          apis.push(api);
        }
        inCodeBlock = false;
        codeBlockContent = '';
      } else {
        // 代码块开始
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent += line + '\n';
      continue;
    }

    // 检测章节标题
    if (line.startsWith('#')) {
      currentSection = line.replace(/#/g, '').trim().toLowerCase();
      continue;
    }

    // 提取关键概念（粗体或代码）
    if (line.includes('**') || line.includes('`')) {
      const concepts = extractConcepts(line);
      keyConcepts.push(...concepts);
    }

    // 提取依赖关系
    if (line.toLowerCase().includes('依赖') || line.toLowerCase().includes('depend')) {
      const deps = extractDependencies(line, content, i);
      dependencies.push(...deps);
    }

    // 提取重要注意事项
    if (line.includes('⚠️') || line.includes('❗') || line.includes('注意') || 
        line.includes('必须') || line.includes('严禁') || line.includes('重要')) {
      const note = line.replace(/[⚠️❗]/g, '').trim();
      if (note && note.length > 5) {
        importantNotes.push(note);
      }
    }

    // 提取 API 定义（表格形式）
    if (line.startsWith('|') && line.includes('(') && line.includes(')')) {
      const api = parseAPITableRow(line);
      if (api) {
        apis.push(api);
      }
    }
  }

  // 去重
  const uniqueKeyConcepts = [...new Set(keyConcepts)].slice(0, 20);
  const uniqueDependencies = [...new Set(dependencies)].slice(0, 10);
  const uniqueImportantNotes = [...new Set(importantNotes)].slice(0, 10);

  return {
    path,
    apis: apis.slice(0, 15), // 最多保留15个API
    keyConcepts: uniqueKeyConcepts,
    dependencies: uniqueDependencies,
    importantNotes: uniqueImportantNotes
  };
}

/**
 * 计算文件内容的哈希值
 */
export function computeFileHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * 解析代码块中的 API 定义
 */
function parseCodeBlock(content: string, language: string): APIDefinition | null {
  // 匹配函数定义：function name(params) 或 const name = (params) =>
  const functionMatch = content.match(/(?:function|const|let|var)\s+(\w+)\s*\(([^)]*)\)/);
  if (functionMatch) {
    const name = functionMatch[1];
    const paramsStr = functionMatch[2];
    const params = parseParams(paramsStr);
    
    // 提取关键注释
    const keyNotes: string[] = [];
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.includes('//') || line.includes('/*')) {
        const comment = line.replace(/.*(\/\/|\/\*)/, '').replace('\*/', '').trim();
        if (comment && (comment.includes('必须') || comment.includes('注意') || 
            comment.includes('⚠️') || comment.includes('重要'))) {
          keyNotes.push(comment);
        }
      }
    }

    return {
      name,
      params,
      returnType: inferReturnType(content, name),
      keyNotes: keyNotes.slice(0, 3),
      description: extractDescription(content)
    };
  }

  // 匹配类方法：ClassName.methodName 或 this.methodName
  const methodMatch = content.match(/(?:this|\w+)\.(\w+)\s*\(([^)]*)\)/);
  if (methodMatch) {
    return {
      name: methodMatch[1],
      params: parseParams(methodMatch[2]),
      returnType: inferReturnType(content, methodMatch[1]),
      keyNotes: [],
      description: extractDescription(content)
    };
  }

  return null;
}

/**
 * 解析参数列表
 */
function parseParams(paramsStr: string): string[] {
  if (!paramsStr.trim()) return [];
  
  return paramsStr.split(',').map(param => {
    const trimmed = param.trim();
    // 提取参数名和类型
    const match = trimmed.match(/(\w+)\s*:\s*(\w+)/);
    if (match) {
      return `${match[1]}: ${match[2]}`;
    }
    return trimmed;
  }).filter(p => p && !p.startsWith('//'));
}

/**
 * 推断返回值类型
 */
function inferReturnType(content: string, functionName: string): string {
  // 查找 return 语句
  const returnMatch = content.match(/return\s+(.+?)(?:;|\n)/);
  if (returnMatch) {
    const returnValue = returnMatch[1].trim();
    if (returnValue.startsWith('{')) return 'Object';
    if (returnValue.startsWith('[')) return 'Array';
    if (returnValue.startsWith('new ')) return returnValue.split(' ')[1];
    if (returnValue === 'true' || returnValue === 'false') return 'boolean';
    if (/^\d/.test(returnValue)) return 'number';
    if (returnValue.startsWith('"') || returnValue.startsWith("'")) return 'string';
    if (returnValue.startsWith('Promise')) return 'Promise';
  }

  // 根据函数名推断
  if (functionName.startsWith('is') || functionName.startsWith('has')) return 'boolean';
  if (functionName.startsWith('get')) return 'any';
  if (functionName.startsWith('set')) return 'void';
  if (functionName.startsWith('create') || functionName.startsWith('new')) return 'Object';

  return 'void';
}

/**
 * 提取描述信息
 */
function extractDescription(content: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && 
        !trimmed.startsWith('*') && !trimmed.startsWith('function') &&
        !trimmed.startsWith('const') && !trimmed.startsWith('let')) {
      return trimmed.substring(0, 100);
    }
  }
  return '';
}

/**
 * 提取关键概念
 */
function extractConcepts(line: string): string[] {
  const concepts: string[] = [];
  
  // 匹配粗体 **concept**
  const boldMatches = line.match(/\*\*([^*]+)\*\*/g);
  if (boldMatches) {
    boldMatches.forEach(match => {
      const concept = match.replace(/\*\*/g, '').trim();
      if (concept.length > 2 && concept.length < 30) {
        concepts.push(concept);
      }
    });
  }

  // 匹配代码 `concept`
  const codeMatches = line.match(/`([^`]+)`/g);
  if (codeMatches) {
    codeMatches.forEach(match => {
      const concept = match.replace(/`/g, '').trim();
      if (concept.length > 2 && concept.length < 30 && 
          !concept.includes('(') && !concept.includes('.')) {
        concepts.push(concept);
      }
    });
  }

  return concepts;
}

/**
 * 提取依赖关系
 */
function extractDependencies(line: string, content: string, currentLine: number): string[] {
  const deps: string[] = [];
  
  // 匹配 skill 路径
  const skillMatches = line.match(/[\w-]+\/[\w-]+/g);
  if (skillMatches) {
    skillMatches.forEach(match => {
      if (match.includes('-') && !match.includes('://')) {
        deps.push(match);
      }
    });
  }

  // 匹配 official 文档
  const officialMatches = line.match(/official[\w-]+/gi);
  if (officialMatches) {
    officialMatches.forEach(match => {
      deps.push(`official_api_code_example/${match}.md`);
    });
  }

  return deps;
}

/**
 * 解析 API 表格行
 */
function parseAPITableRow(line: string): APIDefinition | null {
  const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell);
  if (cells.length < 2) return null;

  const name = cells[0];
  if (!name || name.includes('---') || name.includes('方法') || name.includes('API')) {
    return null;
  }

  // 检查是否是有效的 API 名
  if (!/^[a-zA-Z_]\w*$/.test(name) && !name.includes('.')) {
    return null;
  }

  return {
    name,
    params: cells[1] ? cells[1].split(',').map(p => p.trim()).filter(p => p) : [],
    returnType: cells[2] || 'void',
    keyNotes: cells[3] ? [cells[3]] : [],
    description: cells[4] || ''
  };
}

/**
 * 生成带哈希的完整摘要
 */
export function generateDigestWithHash(content: string, path: string = ''): DigestWithHash {
  const digest = generateDigest(content, path);
  const fileHash = computeFileHash(content);
  
  return {
    digest,
    fileHash,
    generatedAt: new Date().toISOString()
  };
}

/**
 * 将摘要转换为文本格式（用于返回给AI）
 */
export function digestToText(digest: SkillDigest): string {
  const lines: string[] = [];
  
  lines.push(`# ${digest.path} 摘要`);
  lines.push('');
  
  if (digest.apis.length > 0) {
    lines.push('## API 列表');
    lines.push('');
    digest.apis.forEach(api => {
      const params = api.params.join(', ');
      lines.push(`- **${api.name}**(${params}): ${api.returnType}`);
      if (api.keyNotes.length > 0) {
        api.keyNotes.forEach(note => {
          lines.push(`  - ⚠️ ${note}`);
        });
      }
    });
    lines.push('');
  }
  
  if (digest.keyConcepts.length > 0) {
    lines.push('## 关键概念');
    lines.push('');
    lines.push(digest.keyConcepts.join(', '));
    lines.push('');
  }
  
  if (digest.dependencies.length > 0) {
    lines.push('## 依赖');
    lines.push('');
    digest.dependencies.forEach(dep => {
      lines.push(`- ${dep}`);
    });
    lines.push('');
  }
  
  if (digest.importantNotes.length > 0) {
    lines.push('## 重要注意事项');
    lines.push('');
    digest.importantNotes.forEach(note => {
      lines.push(`- ⚠️ ${note}`);
    });
    lines.push('');
  }
  
  return lines.join('\n');
}
