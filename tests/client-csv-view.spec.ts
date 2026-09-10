/**
 * CsvView 组件的纯函数 parseCsv 测试。
 * 组件渲染部分由 E2E 覆盖，这里测解析逻辑的正确性。
 */
import { describe, expect, it } from 'vitest'
import { parseCsv } from '../client/editor/CsvView.tsx'

describe('parseCsv', () => {
  it('基本逗号分隔', () => {
    expect(parseCsv('a,b,c\n1,2,3', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('TSV 制表符分隔', () => {
    expect(parseCsv('a\tb\tc\n1\t2\t3', '\t')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('引号包裹含逗号', () => {
    expect(parseCsv('"a,b",c\n"x,y",z', ',')).toEqual([
      ['a,b', 'c'],
      ['x,y', 'z'],
    ])
  })

  it('引号转义双引号', () => {
    expect(parseCsv('"he said ""hi""",b', ',')).toEqual([
      ['he said "hi"', 'b'],
    ])
  })

  it('引号内换行', () => {
    expect(parseCsv('"line1\nline2",b', ',')).toEqual([
      ['line1\nline2', 'b'],
    ])
  })

  it('CRLF 换行', () => {
    expect(parseCsv('a,b\r\n1,2', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('CR 换行（旧 Mac）', () => {
    expect(parseCsv('a,b\r1,2', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('跳过空行', () => {
    expect(parseCsv('a,b\n\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('行尾空字段保留', () => {
    expect(parseCsv('a,b,\n1,,3', ',')).toEqual([
      ['a', 'b', ''],
      ['1', '', '3'],
    ])
  })

  it('单行无换行', () => {
    expect(parseCsv('a,b,c', ',')).toEqual([['a', 'b', 'c']])
  })

  it('空字符串', () => {
    expect(parseCsv('', ',')).toEqual([])
  })

  it('只有空行', () => {
    expect(parseCsv('\n\n', ',')).toEqual([])
  })

  it('BOM 头被剥掉，不影响引号检测', () => {
    const text = '\uFEFF"a","b"\n"1","2"'
    const result = parseCsv(text, ',')
    expect(result[0]![0]).toBe('a')
    expect(result[0]![1]).toBe('b')
    expect(result[1]![0]).toBe('1')
    expect(result[1]![1]).toBe('2')
  })

  it('列数不一致的行', () => {
    expect(parseCsv('a,b,c\n1,2\nx,y,z,w', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
      ['x', 'y', 'z', 'w'],
    ])
  })

  it('数值不被特殊处理（纯字符串）', () => {
    expect(parseCsv('name,age\nAlice,30\nBob,25', ',')).toEqual([
      ['name', 'age'],
      ['Alice', '30'],
      ['Bob', '25'],
    ])
  })
})
