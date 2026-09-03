import { loadAll, dump } from 'js-yaml'
import { parseAllDocuments, Document } from 'yaml'
import fs from 'fs'
import { Format, ContentNode, FormatParser, QuotingType } from './types'

export const formatGuesser = (filename: string): Format => {
  if (filename.endsWith(Format.JSON)) {
    return Format.JSON
  }
  if (filename.endsWith(Format.YAML) || filename.endsWith('yml')) {
    return Format.YAML
  }

  return Format.UNKNOWN
}

const readFile = (filePath: string): string => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`could not parse file with path: ${filePath}`)
  }

  return fs.readFileSync(filePath, 'utf8')
}

const validateContent = <T>(content: T | undefined, format: Format): T => {
  if (typeof content !== 'object') {
    throw new Error(`could not parse content as ${format.toUpperCase()}`)
  }

  return content
}

/**
 * Every leaf path whose value differs between `before` and `after`.
 *
 * Used to turn "here is the whole mutated object" back into "here are the two
 * fields that actually changed", which is what lets the edit be applied to the
 * original document instead of replacing it.
 *
 * Returns null when a key was removed or a container changed shape, because
 * those cannot be expressed as a set of scalar assignments - the caller falls
 * back to a full re-serialise in that case.
 */
const changedPaths = (
  before: unknown,
  after: unknown,
  path: (string | number)[] = []
): { path: (string | number)[]; value: unknown }[] | null => {
  if (before === after) return []

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of Object.keys(before)) {
      if (!(key in after)) return null // a removal - cannot express as a set
    }
    const out: { path: (string | number)[]; value: unknown }[] = []
    for (const key of Object.keys(after)) {
      const nested = changedPaths(before[key], after[key], [...path, key])
      if (nested === null) return null
      out.push(...nested)
    }
    return out
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    // Arrays are replaced wholesale rather than element-wise: an append or a
    // reorder is not a scalar assignment, and guessing would corrupt the file.
    if (JSON.stringify(before) === JSON.stringify(after)) return []
    return [{ path, value: after }]
  }

  return [{ path, value: after }]
}

class YAMLMultiFileParser {
  private isMultifile = false
  // The source documents, kept so an edit can be applied to them rather than
  // to a freshly serialised object. js-yaml has no concept of comments, so
  // re-dumping the mutated object silently deleted every comment in the file -
  // which for a Helm values.yaml is most of its documentation.
  private documents: Document[] = []
  private original: ContentNode[] = []

  convert<T extends ContentNode>(filePath: string): T {
    const text = readFile(filePath)
    try {
      this.documents = parseAllDocuments(text) as unknown as Document[]
    } catch {
      this.documents = []
    }

    const content = loadAll(text) as ContentNode[]
    this.original = content
    if (content.length <= 1) {
      this.isMultifile = false
      return validateContent<T>(content[0] as T, Format.YAML)
    }
    this.isMultifile = true
    for (const entry of content) {
      validateContent(entry, Format.YAML)
    }
    return content as unknown as T
  }

  /**
   * Apply the changes onto the parsed documents so comments and formatting
   * survive. Returns null if the edit cannot be expressed that way, so the
   * caller can fall back to the previous behaviour rather than fail.
   */
  private dumpPreservingComments<T extends ContentNode>(
    content: T
  ): string | null {
    if (this.documents.length === 0) return null
    if (this.documents.length !== this.original.length) return null

    const after = (
      this.isMultifile ? (content as unknown as ContentNode[]) : [content]
    ) as unknown[]
    if (after.length !== this.original.length) return null

    const rendered: string[] = []
    for (let i = 0; i < this.documents.length; i++) {
      const changes = changedPaths(this.original[i], after[i])
      if (changes === null) return null

      const doc = this.documents[i]
      for (const change of changes) {
        if (change.path.length === 0) return null
        doc.setIn(change.path, change.value)
      }
      rendered.push(doc.toString({ lineWidth: 0 }))
    }

    return this.isMultifile ? rendered.join('---\n') : rendered[0]
  }

  dump<T extends ContentNode>(
    content: T,
    options?: {
      noCompatMode: boolean
      quotingType?: QuotingType
    }
  ): string {
    const preserved = this.dumpPreservingComments(content)
    if (preserved !== null) {
      return preserved
    }

    if (this.isMultifile) {
      const entries = content as unknown as T[]
      const fileContents = entries.map(v => this.internal_dump(v, options))
      return fileContents.join('\n\n---\n\n')
    } else {
      return this.internal_dump(content, options)
    }
  }

  private internal_dump<T extends ContentNode>(
    content: T,
    options?: {
      noCompatMode: boolean
      quotingType?: QuotingType
    }
  ): string {
    return dump(content, {
      lineWidth: -1,
      noCompatMode: options?.noCompatMode,
      quotingType: options?.quotingType
    })
  }
}

const JSONParser = {
  convert<T extends ContentNode>(filePath: string): T {
    try {
      return validateContent<T>(
        JSON.parse(readFile(filePath)) as T,
        Format.JSON
      )
    } catch {
      return validateContent<T>(undefined, Format.JSON)
    }
  },
  dump<T extends ContentNode>(content: T): string {
    return JSON.stringify(content, null, 2)
  }
}

export const formatParser: {
  [key in Exclude<Format, Format.UNKNOWN>]: FormatParser
} = {
  [Format.JSON]: JSONParser,
  [Format.YAML]: new YAMLMultiFileParser()
}
