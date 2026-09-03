import { replace } from '../src/action'
import { formatParser, formatGuesser } from '../src/parser'
import { Format, Method } from '../src/types'
import fs from 'fs'
import path from 'path'

/**
 * Regression tests for comment loss.
 *
 * The action used to parse YAML into a plain object, mutate it, and re-dump it
 * with js-yaml - which has no concept of comments, so every comment in the file
 * was silently deleted. On a Helm values.yaml that is most of its
 * documentation: one release bump removed 185 lines of it.
 */
describe('comment preservation', () => {
  const fixture = path.join(__dirname, 'fixtures', 'values-with-comments.yaml')

  const roundTrip = (file: string, jsonPath: string, value: string): string => {
    const parser = formatParser[formatGuesser(file) as Exclude<Format, Format.UNKNOWN>]
    const content = parser.convert(file)
    const updated = replace(value, jsonPath, content, Method.CreateOrUpdate)
    return parser.dump(updated, { noCompatMode: true })
  }

  it('changes only the targeted line', () => {
    const before = fs.readFileSync(fixture, 'utf8')
    const after = roundTrip(fixture, 'datavault.image.tag', 'v9.9.9')

    const beforeLines = before.split('\n')
    const afterLines = after.split('\n')

    expect(afterLines.length).toBe(beforeLines.length)

    const differing = beforeLines
      .map((line, i) => (line === afterLines[i] ? null : i))
      .filter((i): i is number => i !== null)

    expect(differing).toHaveLength(1)
    expect(afterLines[differing[0]]).toContain('v9.9.9')
  })

  it('keeps every comment', () => {
    const before = fs.readFileSync(fixture, 'utf8')
    const after = roundTrip(fixture, 'datavault.image.tag', 'v9.9.9')

    const comments = (s: string): number =>
      s.split('\n').filter(l => l.trim().startsWith('#')).length

    expect(comments(after)).toBe(comments(before))
    expect(comments(before)).toBeGreaterThan(100)
  })

  it('still applies the value', () => {
    const after = roundTrip(fixture, 'datavault.image.tag', 'v9.9.9')
    expect(after).toContain('tag: v9.9.9')
    expect(after).not.toContain('tag: v1.0.35')
  })
})
