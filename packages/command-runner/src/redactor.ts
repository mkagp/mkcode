// @effect-diagnostics nodeBuiltinImport:off
import * as NodeStringDecoder from "node:string_decoder";

const REDACTION = "[REDACTED]";
const PATTERN_CARRY_LENGTH = 512;
const TOKEN_CHARACTER = /^[A-Za-z0-9._~+/=-]$/u;

const sensitivePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9._~+/=-])/giu,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{8,}['"]?/giu,
] as const;
const unfinishedSensitivePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}$/iu,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}$/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}$/u,
  /\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{8,}$/iu,
] as const;

const redactPatterns = (value: string): string => {
  let redacted = value;
  for (const pattern of sensitivePatterns) redacted = redacted.replace(pattern, REDACTION);
  return redacted;
};

export class StreamingRedactor {
  readonly #decoder = new NodeStringDecoder.StringDecoder("utf8");
  readonly #secrets: ReadonlyArray<string>;
  readonly #carryLength: number;
  #pending = "";
  #suppressPatternToken = false;

  constructor(values: ReadonlyArray<string>) {
    this.#secrets = [
      ...new Set(
        values
          .filter((value) => value.length > 0)
          .sort((left, right) => right.length - left.length),
      ),
    ];
    this.#carryLength = Math.max(
      PATTERN_CARRY_LENGTH,
      ...this.#secrets.map((secret) => secret.length - 1),
    );
  }

  push(chunk: Uint8Array): string {
    let decoded = this.#decoder.write(Buffer.from(chunk));
    if (this.#suppressPatternToken) {
      let index = 0;
      while (index < decoded.length && TOKEN_CHARACTER.test(decoded[index]!)) index += 1;
      if (index === decoded.length) return "";
      this.#suppressPatternToken = false;
      decoded = decoded.slice(index);
    }
    const combined = this.#pending + decoded;
    const unfinished = unfinishedSensitivePatterns
      .map((pattern) => pattern.exec(combined))
      .filter((match): match is RegExpExecArray => match !== null)
      .filter((match) => match.index + match[0].length === combined.length)
      .sort((left, right) => left.index - right.index)[0];
    if (unfinished) {
      this.#pending = "";
      this.#suppressPatternToken = true;
      return `${this.#redact(combined.slice(0, unfinished.index))}${REDACTION}`;
    }
    if (combined.length <= this.#carryLength) {
      this.#pending = combined;
      return "";
    }

    let emitEnd = combined.length - this.#carryLength;
    for (const secret of this.#secrets) {
      let position = combined.indexOf(secret);
      while (position !== -1) {
        if (position < emitEnd && position + secret.length > emitEnd) {
          emitEnd = position + secret.length;
        }
        position = combined.indexOf(secret, position + 1);
      }
    }
    for (const pattern of sensitivePatterns) {
      for (const match of combined.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        if (start < emitEnd && end > emitEnd) emitEnd = end;
      }
    }
    if (
      emitEnd > 0 &&
      emitEnd < combined.length &&
      combined.charCodeAt(emitEnd - 1) >= 0xd800 &&
      combined.charCodeAt(emitEnd - 1) <= 0xdbff &&
      combined.charCodeAt(emitEnd) >= 0xdc00 &&
      combined.charCodeAt(emitEnd) <= 0xdfff
    ) {
      emitEnd -= 1;
    }
    const emitted = combined.slice(0, emitEnd);
    this.#pending = combined.slice(emitEnd);
    return this.#redact(emitted);
  }

  finish(): string {
    const final = this.#pending + this.#decoder.end();
    this.#pending = "";
    return this.#redact(final);
  }

  #redact(value: string): string {
    let redacted = value;
    for (const secret of this.#secrets) redacted = redacted.split(secret).join(REDACTION);
    return redactPatterns(redacted);
  }
}
