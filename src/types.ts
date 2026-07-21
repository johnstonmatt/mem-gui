export interface MemoryFile {
  path: string;
  filename: string;
  domain: string;
  domainLabel: string;
  name: string;
  description: string;
  type: string;
  isIndex: boolean;
  chars: number;
  tokens: number;
  mtime: number;
}

export interface Domain {
  domain: string;
  domainLabel: string;
  files: MemoryFile[];
  totalTokens: number;
}
