/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Forward JSON navigation over checked immutable source ranges.

use super::{
    ByteCursor, ChargedBuffer, JsonSource, SourceBudget, SourceBytes, TextEncoding, TextSource,
};
use std::{cmp::Ordering, io, ops::Range, sync::Arc};

pub mod number;
mod walk;
pub use walk::{JsonStructureEvent, JsonStructureValue, StructureCursor};

const READ_BYTES: usize = 32 * 1024;
// The initial stack covers serde_json's default depth; it grows within the envelope.
const INITIAL_NESTING_BYTES: usize = 128;
// serde_json starts at 128 and rejects the container that decrements it to zero.
const SERDE_VALUE_RECURSION_LIMIT: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonKind {
    Object,
    Array,
    String,
    Number,
    Bool,
    Null,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JsonCounts {
    pub objects: u64,
    pub arrays: u64,
    pub members: u64,
    pub elements: u64,
    pub leaves: u64,
}
impl JsonCounts {
    fn value(&mut self, kind: JsonKind) -> io::Result<()> {
        let count = match kind {
            JsonKind::Object => &mut self.objects,
            JsonKind::Array => &mut self.arrays,
            _ => &mut self.leaves,
        };
        *count = count
            .checked_add(1)
            .ok_or_else(|| invalid("JSON structure count overflow"))?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct JsonValue {
    pub source: JsonSource,
    pub kind: JsonKind,
}
impl JsonValue {
    pub fn text(&self) -> io::Result<TextSource> {
        if self.kind != JsonKind::String {
            return Err(invalid("JSON value is not a string"));
        }
        Ok(TextSource::new(
            self.source.bytes.clone(),
            TextEncoding::JsonString,
        ))
    }
}
#[derive(Clone, Debug)]
pub struct JsonField {
    pub key: TextSource,
    pub value: JsonValue,
}

/// Byte ranges relative to the exact source passed to `ObjectCursor::open`.
/// Key ranges contain the complete quoted token; values exclude whitespace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonFieldSpans {
    pub key_range: Range<u64>,
    pub value_range: Range<u64>,
    pub kind: JsonKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonValueSpans {
    pub value_range: Range<u64>,
    pub kind: JsonKind,
}

fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}

#[derive(Debug)]
struct JsonSyntaxError {
    reason: &'static str,
    cause: Option<Box<dyn std::error::Error + Send + Sync>>,
}
impl std::fmt::Display for JsonSyntaxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason)
    }
}
impl std::error::Error for JsonSyntaxError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause
            .as_ref()
            .map(|cause| &**cause as &(dyn std::error::Error + 'static))
    }
}
fn syntax(reason: &'static str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        JsonSyntaxError {
            reason,
            cause: None,
        },
    )
}
fn number_syntax(error: io::Error) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        JsonSyntaxError {
            reason: "JSON number is outside serde Value's finite range",
            cause: Some(Box::new(error)),
        },
    )
}
/// Only local JSON grammar failures qualify; source IO and capability failures
/// retain their original error and must never become a synthetic JSON value.
pub fn is_syntax_error(error: &io::Error) -> bool {
    error
        .get_ref()
        .is_some_and(|error| error.is::<JsonSyntaxError>())
}

fn validate_utf8(bytes: &[u8]) -> io::Result<&str> {
    std::str::from_utf8(bytes).map_err(utf8_syntax)
}

fn utf8_syntax(error: std::str::Utf8Error) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        JsonSyntaxError {
            reason: "invalid JSON UTF-8",
            cause: Some(Box::new(error)),
        },
    )
}

fn hex(digits: &[u8]) -> io::Result<u16> {
    let mut value = 0u16;
    for &byte in digits {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return Err(syntax("invalid JSON unicode escape")),
        };
        value = value * 16 + u16::from(digit);
    }
    Ok(value)
}

/// None means the escape continues in the next read.
fn decode_escape(bytes: &[u8]) -> io::Result<Option<(char, usize)>> {
    let Some(&code) = bytes.get(1) else {
        return Ok(None);
    };
    let character = match code {
        b'"' | b'\\' | b'/' => char::from(code),
        b'b' => '\u{8}',
        b'f' => '\u{c}',
        b'n' => '\n',
        b'r' => '\r',
        b't' => '\t',
        b'u' => {
            let Some(digits) = bytes.get(2..6) else {
                return Ok(None);
            };
            let first = hex(digits)?;
            let (scalar, consumed) = if (0xd800..=0xdbff).contains(&first) {
                let Some(tail) = bytes.get(6..12) else {
                    return Ok(None);
                };
                if !tail.starts_with(b"\\u") {
                    return Err(syntax("invalid JSON surrogate pair"));
                }
                let second = hex(&tail[2..])?;
                if !(0xdc00..=0xdfff).contains(&second) {
                    return Err(syntax("invalid JSON surrogate pair"));
                }
                (
                    0x10000 + (u32::from(first) - 0xd800) * 0x400 + u32::from(second) - 0xdc00,
                    12,
                )
            } else {
                (u32::from(first), 6)
            };
            let character =
                char::from_u32(scalar).ok_or_else(|| syntax("invalid JSON unicode scalar"))?;
            return Ok(Some((character, consumed)));
        }
        _ => return Err(syntax("invalid JSON escape")),
    };
    Ok(Some((character, 2)))
}

enum TextPiece<'a> {
    Run(&'a str),
    Escape(char, usize),
    Close,
    Refill,
}

/// Length of the run that can be copied verbatim inside a JSON string.
#[inline]
pub fn plain_prefix(bytes: &[u8]) -> usize {
    const LOW: u64 = u64::from_ne_bytes([1; 8]);
    const HIGH: u64 = u64::from_ne_bytes([0x80; 8]);
    const CONTROL: u64 = u64::from_ne_bytes([0xe0; 8]);
    const QUOTE: u64 = u64::from_ne_bytes([b'"'; 8]);
    const BACKSLASH: u64 = u64::from_ne_bytes([b'\\'; 8]);

    fn has_zero_byte(word: u64) -> bool {
        word.wrapping_sub(LOW) & !word & HIGH != 0
    }

    let (words, _) = bytes.as_chunks::<8>();
    let words = words.iter().take_while(|word| {
        let word = u64::from_ne_bytes(**word);
        !has_zero_byte(word & CONTROL)
            && !has_zero_byte(word ^ QUOTE)
            && !has_zero_byte(word ^ BACKSLASH)
    });
    let start = words.count() * 8;
    start
        + bytes[start..]
            .iter()
            .position(|byte| matches!(byte, b'"' | b'\\' | 0..=31))
            .unwrap_or(bytes.len() - start)
}

fn text_piece(bytes: &[u8], encoding: TextEncoding) -> io::Result<TextPiece<'_>> {
    let plain = match encoding {
        TextEncoding::Utf8 => bytes,
        TextEncoding::JsonString => {
            let end = plain_prefix(bytes);
            if end == 0 {
                return Ok(match bytes.first() {
                    Some(b'"') => TextPiece::Close,
                    Some(b'\\') => match decode_escape(bytes)? {
                        Some((character, count)) => TextPiece::Escape(character, count),
                        None => TextPiece::Refill,
                    },
                    Some(_) => return Err(syntax("unescaped JSON control character")),
                    None => TextPiece::Refill,
                });
            }
            &bytes[..end]
        }
    };
    if plain.is_empty() {
        return Ok(TextPiece::Refill);
    }
    match std::str::from_utf8(plain) {
        Ok(run) => Ok(TextPiece::Run(run)),
        Err(error) if error.error_len().is_none() && plain.len() == bytes.len() => {
            let end = error.valid_up_to();
            if end == 0 {
                Ok(TextPiece::Refill)
            } else {
                Ok(TextPiece::Run(validate_utf8(&plain[..end])?))
            }
        }
        Err(error) => Err(utf8_syntax(error)),
    }
}

struct Reader {
    source: SourceBytes,
    cursor: Option<Box<dyn ByteCursor>>,
    budget: Arc<dyn SourceBudget>,
    buffer: Option<ChargedBuffer>,
    at: usize,
    used: usize,
    eof: bool,
    chunk_start: u64,
    legacy_value: bool,
}
impl Reader {
    async fn new(source: SourceBytes, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        let (cursor, buffer) = match &source {
            SourceBytes::Inline(_) => (None, None),
            SourceBytes::Source(source) => (
                Some(source.open(budget.clone())),
                Some(
                    budget
                        .allocate(
                            source
                                .len()
                                .and_then(|len| usize::try_from(len).ok())
                                .unwrap_or(READ_BYTES)
                                .clamp(1, READ_BYTES),
                        )
                        .await?,
                ),
            ),
        };
        Ok(Self {
            source,
            cursor,
            budget,
            buffer,
            at: 0,
            used: 0,
            eof: false,
            chunk_start: 0,
            legacy_value: false,
        })
    }
    fn loaded(&self) -> &[u8] {
        match &self.source {
            SourceBytes::Inline(bytes) => bytes,
            SourceBytes::Source(_) => self
                .buffer
                .as_ref()
                .map_or(&[], |buffer| &buffer.as_ref()[..self.used]),
        }
    }
    fn remaining(&self) -> &[u8] {
        &self.loaded()[self.at..]
    }
    fn position(&self) -> u64 {
        self.chunk_start + self.at as u64
    }
    fn advance(&mut self, count: usize) {
        self.at += count;
    }
    fn peek(&self) -> Option<u8> {
        self.remaining().first().copied()
    }
    async fn refill(&mut self) -> io::Result<bool> {
        debug_assert!(self.remaining().is_empty());
        if self.eof {
            return Ok(false);
        }
        let start = self.position();
        let Some(cursor) = &mut self.cursor else {
            return Ok(false);
        };
        let mut buffer = self
            .buffer
            .take()
            .ok_or_else(|| invalid("JSON reader lost its allocation"))?;
        // A failed or cancelled read settles the allocation without returning it.
        self.chunk_start = start;
        self.at = 0;
        self.used = 0;
        buffer.limit(READ_BYTES);
        let read = cursor.read_chunk(buffer).await?;
        if read.bytes_read > read.buffer.as_ref().len() || (read.bytes_read == 0 && !read.eof) {
            return Err(invalid("JSON source returned an invalid read"));
        }
        let read_end = start
            .checked_add(read.bytes_read as u64)
            .ok_or_else(|| invalid("JSON source position overflow"))?;
        if let SourceBytes::Source(source) = &self.source
            && source
                .len()
                .is_some_and(|len| read_end > len || (read.eof && read_end != len))
        {
            return Err(invalid("JSON source length disagrees with its bytes"));
        }
        self.buffer = Some(read.buffer);
        self.used = read.bytes_read;
        self.eof = read.eof;
        Ok(self.used != 0)
    }
    async fn expect(&mut self, expected: u8) -> io::Result<()> {
        self.literal(&[expected]).await
    }
    async fn whitespace(&mut self) -> io::Result<()> {
        loop {
            let bytes = self.remaining();
            if let Some(count) = bytes
                .iter()
                .position(|byte| !matches!(byte, b' ' | b'\n' | b'\r' | b'\t'))
            {
                self.advance(count);
                return Ok(());
            }
            self.advance(bytes.len());
            if !self.refill().await? {
                return Ok(());
            }
        }
    }
    async fn end(&mut self) -> io::Result<()> {
        self.whitespace().await?;
        if self.peek().is_some() {
            return Err(syntax("trailing JSON content"));
        }
        Ok(())
    }
    fn range(&self, start: u64, end: u64) -> io::Result<JsonSource> {
        if start > end || end > self.position() {
            return Err(invalid("JSON source range is invalid"));
        }
        Ok(JsonSource::new(self.source.slice(start..end)?))
    }
    async fn read_exact(&mut self, mut out: &mut [u8]) -> io::Result<()> {
        while !out.is_empty() {
            if self.remaining().is_empty() && !self.refill().await? {
                return Err(syntax("truncated JSON source"));
            }
            let count = self.remaining().len().min(out.len());
            out[..count].copy_from_slice(&self.remaining()[..count]);
            out = &mut out[count..];
            self.advance(count);
        }
        Ok(())
    }
    async fn split_escape(&mut self) -> io::Result<char> {
        let mut bytes = [0; 12];
        self.read_exact(&mut bytes[..2]).await?;
        if bytes[1] == b'u' {
            self.read_exact(&mut bytes[2..6]).await?;
            if decode_escape(&bytes[..6])?.is_none() {
                self.read_exact(&mut bytes[6..]).await?;
            }
        }
        Ok(decode_escape(&bytes)?.expect("complete JSON escape").0)
    }
    async fn split_utf8<'a>(&mut self, first: u8, out: &'a mut [u8; 4]) -> io::Result<&'a str> {
        let len = match first {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => unreachable!("only an incomplete UTF-8 scalar reaches refill"),
        };
        self.read_exact(&mut out[..len]).await?;
        validate_utf8(&out[..len])
    }
    async fn string(&mut self) -> io::Result<()> {
        self.string_with(|_| {}).await
    }
    async fn string_with(&mut self, mut text: impl FnMut(&str)) -> io::Result<()> {
        self.expect(b'"').await?;
        let mut scalar = [0; 4];
        loop {
            let bytes = self.remaining();
            match text_piece(bytes, TextEncoding::JsonString)? {
                TextPiece::Run(run) => {
                    text(run);
                    self.advance(run.len());
                }
                TextPiece::Escape(character, count) => {
                    text(character.encode_utf8(&mut scalar));
                    self.advance(count);
                }
                TextPiece::Close => {
                    self.advance(1);
                    return Ok(());
                }
                TextPiece::Refill if bytes.is_empty() => {
                    if !self.refill().await? {
                        return Err(syntax("truncated JSON source"));
                    }
                }
                TextPiece::Refill if bytes[0] == b'\\' => {
                    text(self.split_escape().await?.encode_utf8(&mut scalar));
                }
                TextPiece::Refill => {
                    text(self.split_utf8(bytes[0], &mut scalar).await?);
                }
            }
        }
    }
    fn number_prefix(
        &mut self,
        count: usize,
        validator: &mut Option<&mut number::NumberValidator>,
    ) -> io::Result<()> {
        if let Some(validator) = validator {
            for &byte in &self.remaining()[..count] {
                validator.push(byte).map_err(number_syntax)?;
            }
        }
        self.advance(count);
        Ok(())
    }
    async fn digits(
        &mut self,
        validator: &mut Option<&mut number::NumberValidator>,
    ) -> io::Result<bool> {
        let mut has_digits = false;
        loop {
            let bytes = self.remaining();
            let count = bytes
                .iter()
                .position(|byte| !byte.is_ascii_digit())
                .unwrap_or(bytes.len());
            let has_delimiter = count < bytes.len();
            has_digits |= count != 0;
            self.number_prefix(count, validator)?;
            if has_delimiter || !self.refill().await? {
                return Ok(has_digits);
            }
        }
    }
    async fn number(&mut self) -> io::Result<()> {
        if self.legacy_value {
            // Only the embedded-Value consumer owns this fixed numeric state.
            // Ordinary canonical cursors do not retain it in their future frame.
            Box::pin(self.number_legacy()).await
        } else {
            self.number_lexeme(None).await
        }
    }
    async fn number_legacy(&mut self) -> io::Result<()> {
        let mut validator = number::NumberValidator::new();
        self.number_lexeme(Some(&mut validator)).await?;
        validator
            .into_representative_value()
            .map_err(number_syntax)?;
        Ok(())
    }
    async fn number_lexeme(
        &mut self,
        mut validator: Option<&mut number::NumberValidator>,
    ) -> io::Result<()> {
        if self.peek() == Some(b'-') {
            self.number_prefix(1, &mut validator)?;
            if self.remaining().is_empty() {
                self.refill().await?;
            }
        }
        match self.peek() {
            Some(b'0') => self.number_prefix(1, &mut validator)?,
            Some(b'1'..=b'9') => {
                self.digits(&mut validator).await?;
            }
            Some(_) => return Err(syntax("invalid JSON number")),
            None => return Err(syntax("truncated JSON number")),
        }
        if self.remaining().is_empty() {
            self.refill().await?;
        }
        if self.peek() == Some(b'.') {
            self.number_prefix(1, &mut validator)?;
            if !self.digits(&mut validator).await? {
                return Err(syntax("invalid JSON fraction"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.number_prefix(1, &mut validator)?;
            if self.remaining().is_empty() {
                self.refill().await?;
            }
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.number_prefix(1, &mut validator)?;
            }
            if !self.digits(&mut validator).await? {
                return Err(syntax("invalid JSON exponent"));
            }
        }
        Ok(())
    }
    async fn literal(&mut self, mut expected: &[u8]) -> io::Result<()> {
        while !expected.is_empty() {
            if self.remaining().is_empty() && !self.refill().await? {
                return Err(syntax("truncated JSON source"));
            }
            let count = expected.len().min(self.remaining().len());
            if self.remaining()[..count] != expected[..count] {
                return Err(syntax("unexpected JSON token"));
            }
            self.advance(count);
            expected = &expected[count..];
        }
        Ok(())
    }
    async fn begin_value(&mut self) -> io::Result<(JsonKind, Option<u8>)> {
        self.whitespace().await?;
        Ok(
            match self.peek().ok_or_else(|| syntax("missing JSON value"))? {
                b'{' => {
                    self.advance(1);
                    (JsonKind::Object, Some(0))
                }
                b'[' => {
                    self.advance(1);
                    (JsonKind::Array, Some(5))
                }
                b'"' => {
                    self.string().await?;
                    (JsonKind::String, None)
                }
                b't' => {
                    self.literal(b"true").await?;
                    (JsonKind::Bool, None)
                }
                b'f' => {
                    self.literal(b"false").await?;
                    (JsonKind::Bool, None)
                }
                b'n' => {
                    self.literal(b"null").await?;
                    (JsonKind::Null, None)
                }
                b'-' | b'0'..=b'9' => {
                    self.number().await?;
                    (JsonKind::Number, None)
                }
                _ => return Err(syntax("invalid JSON value")),
            },
        )
    }
    async fn scan_value(&mut self) -> io::Result<(u64, u64, JsonKind, JsonCounts)> {
        self.whitespace().await?;
        let start = self.position();
        let (kind, first) = self.begin_value().await?;
        let mut counts = JsonCounts::default();
        counts.value(kind)?;
        if let Some(first) = first {
            // Structural memory grows only with nesting and stays in the caller's
            // charged envelope. Token size never changes the work allocation.
            let mut stack = self.budget.allocate(INITIAL_NESTING_BYTES).await?;
            let mut depth = 1usize;
            if stack.as_mut().is_empty() {
                return Err(invalid("JSON nesting allocation is empty"));
            }
            stack.as_mut()[0] = first;
            while depth != 0 {
                self.whitespace().await?;
                let state = stack.as_ref()[depth - 1];
                let mut child = None;
                match state {
                    0 | 1 => {
                        if state == 0 && self.peek() == Some(b'}') {
                            self.advance(1);
                            depth -= 1;
                            continue;
                        }
                        self.string().await?;
                        self.whitespace().await?;
                        self.expect(b':').await?;
                        stack.as_mut()[depth - 1] = 4;
                        counts.members = counts
                            .members
                            .checked_add(1)
                            .ok_or_else(|| invalid("JSON member count overflow"))?;
                        let (kind, next) = self.begin_value().await?;
                        counts.value(kind)?;
                        child = next;
                    }
                    4 => {
                        match self.peek() {
                            Some(b'}') => depth -= 1,
                            Some(b',') => stack.as_mut()[depth - 1] = 1,
                            _ => return Err(syntax("invalid JSON object separator")),
                        }
                        self.advance(1);
                    }
                    5 | 6 => {
                        if state == 5 && self.peek() == Some(b']') {
                            self.advance(1);
                            depth -= 1;
                            continue;
                        }
                        stack.as_mut()[depth - 1] = 7;
                        counts.elements = counts
                            .elements
                            .checked_add(1)
                            .ok_or_else(|| invalid("JSON element count overflow"))?;
                        let (kind, next) = self.begin_value().await?;
                        counts.value(kind)?;
                        child = next;
                    }
                    7 => {
                        match self.peek() {
                            Some(b']') => depth -= 1,
                            Some(b',') => stack.as_mut()[depth - 1] = 6,
                            _ => return Err(syntax("invalid JSON array separator")),
                        }
                        self.advance(1);
                    }
                    _ => unreachable!("JSON scanner nesting state is internal"),
                }
                if let Some(child) = child {
                    if self.legacy_value && depth >= SERDE_VALUE_RECURSION_LIMIT - 1 {
                        return Err(syntax("serde Value recursion limit exceeded"));
                    }
                    if depth == stack.as_mut().len() {
                        let capacity = depth
                            .checked_mul(2)
                            .ok_or_else(|| invalid("JSON nesting allocation overflow"))?;
                        let mut grown = self.budget.allocate(capacity).await?;
                        if grown.as_mut().len() < capacity {
                            return Err(invalid("JSON nesting allocation is too small"));
                        }
                        grown.as_mut()[..depth].copy_from_slice(&stack.as_ref()[..depth]);
                        stack = grown;
                    }
                    stack.as_mut()[depth] = child;
                    depth += 1;
                }
            }
        }
        Ok((start, self.position(), kind, counts))
    }
    async fn value_span(&mut self) -> io::Result<(u64, u64, JsonKind)> {
        let (start, end, kind, _) = self.scan_value().await?;
        Ok((start, end, kind))
    }
    async fn value(&mut self) -> io::Result<JsonValue> {
        let (start, end, kind) = self.value_span().await?;
        Ok(JsonValue {
            source: self.range(start, end)?,
            kind,
        })
    }
}

/// Classify an already-validated value without visiting its body. Iteration and
/// `inspect` separately check complete structure and source EOF.
pub async fn kind(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<JsonKind> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    reader.whitespace().await?;
    match reader.peek() {
        Some(b'{') => Ok(JsonKind::Object),
        Some(b'[') => Ok(JsonKind::Array),
        Some(b'"') => Ok(JsonKind::String),
        Some(b't' | b'f') => Ok(JsonKind::Bool),
        Some(b'n') => Ok(JsonKind::Null),
        Some(b'-' | b'0'..=b'9') => Ok(JsonKind::Number),
        _ => Err(syntax("missing or invalid JSON value")),
    }
}

/// Validate a complete decoded byte stream without minting indexed subranges.
/// Transformed JSON must be published to indexed backing before field lookup.
pub async fn validate_bytes(
    source: &SourceBytes,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<JsonKind> {
    let mut reader = Reader::new(source.clone(), budget).await?;
    let (_, _, kind) = reader.value_span().await?;
    reader.end().await?;
    Ok(kind)
}

/// Match the legacy `serde_json::Value` parse boundary for JSON embedded in
/// tool-error text: configured serde number semantics and the default recursion limit.
/// Ordinary already-validated canonical sources use `validate_bytes` instead.
pub async fn validate_value_bytes(
    source: &SourceBytes,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<JsonKind> {
    let mut reader = Reader::new(source.clone(), budget).await?;
    reader.legacy_value = true;
    let (_, _, kind) = reader.value_span().await?;
    reader.end().await?;
    Ok(kind)
}

/// Count actual raw structure in one traversal, including duplicate members.
/// Opaque leaf length never increases directory accounting.
pub async fn measure(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<JsonCounts> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    let (_, _, _, counts) = reader.scan_value().await?;
    reader.end().await?;
    Ok(counts)
}

pub async fn inspect(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<JsonValue> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    let value = reader.value().await?;
    reader.end().await?;
    Ok(value)
}

pub async fn usize_value(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<usize> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    reader.whitespace().await?;
    let mut digits = String::new();
    loop {
        if reader.remaining().is_empty() {
            reader.refill().await?;
        }
        let Some(byte) = reader.peek() else { break };
        if !byte.is_ascii_digit() {
            break;
        }
        if digits.len() >= 24 {
            return Err(invalid("JSON integer exceeds usize range"));
        }
        digits.push(byte as char);
        reader.advance(1);
    }
    if digits.is_empty() || (digits.len() > 1 && digits.starts_with('0')) {
        return Err(invalid("JSON value is not an unsigned integer"));
    }
    reader.end().await?;
    digits
        .parse::<usize>()
        .map_err(|_| invalid("JSON integer exceeds usize range"))
}

pub struct ObjectCursor {
    reader: Reader,
    first: bool,
    done: bool,
    matches: Option<ChargedBuffer>,
}
impl ObjectCursor {
    pub async fn open(source: JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        let mut reader = Reader::new(source.bytes, budget).await?;
        reader.whitespace().await?;
        reader.expect(b'{').await?;
        Ok(Self {
            reader,
            first: true,
            done: false,
            matches: None,
        })
    }
    pub async fn next(&mut self) -> io::Result<Option<JsonField>> {
        let Some(spans) = self.next_spans().await? else {
            return Ok(None);
        };
        Ok(Some(self.field(spans)?))
    }
    /// A fixed-record directory can retain spans without allocating one source
    /// adapter per field. Its existing input source remains the read authority.
    pub async fn next_spans(&mut self) -> io::Result<Option<JsonFieldSpans>> {
        self.next_spans_with_key(|_| {}).await
    }
    /// Scan one original field and match its decoded key against finite schema
    /// names. The first matching name's index accompanies the unchanged spans.
    pub async fn next_named_spans<'a>(
        &mut self,
        names: impl Iterator<Item = &'a str> + Clone,
    ) -> io::Result<Option<(JsonFieldSpans, Option<usize>)>> {
        let count = names.clone().count();
        if count == 0 {
            return Ok(self.next_spans().await?.map(|spans| (spans, None)));
        }
        let mut matches = match self.matches.take() {
            Some(buffer) if buffer.as_ref().len() >= count => buffer,
            _ => self.reader.budget.allocate(count).await?,
        };
        if matches.as_ref().len() < count {
            return Err(invalid("JSON field selector allocation is too small"));
        }
        matches.as_mut()[..count].fill(1);
        let mut key_bytes = 0u64;
        let mut candidates = count;
        let spans = self
            .next_spans_with_key(|text| {
                if candidates == 0 {
                    return;
                }
                let encoded = text.as_bytes();
                for (matched, name) in matches.as_mut().iter_mut().zip(names.clone()) {
                    if *matched != 0 {
                        *matched = u8::from(
                            usize::try_from(key_bytes)
                                .ok()
                                .and_then(|at| name.as_bytes().get(at..))
                                .is_some_and(|rest| rest.starts_with(encoded)),
                        );
                        if *matched == 0 {
                            candidates -= 1;
                        }
                    }
                }
                key_bytes += encoded.len() as u64;
            })
            .await?;
        let selected = names.enumerate().find_map(|(index, name)| {
            (matches.as_ref()[index] != 0 && key_bytes == name.len() as u64).then_some(index)
        });
        self.matches = Some(matches);
        Ok(spans.map(|spans| (spans, selected)))
    }
    /// Match schema names while retaining the original key and value sources.
    pub async fn next_named<'a>(
        &mut self,
        names: impl Iterator<Item = &'a str> + Clone,
    ) -> io::Result<Option<(JsonField, Option<usize>)>> {
        let Some((spans, selected)) = self.next_named_spans(names).await? else {
            return Ok(None);
        };
        Ok(Some((self.field(spans)?, selected)))
    }
    fn field(&self, spans: JsonFieldSpans) -> io::Result<JsonField> {
        Ok(JsonField {
            key: TextSource::new(
                self.reader
                    .range(spans.key_range.start, spans.key_range.end)?
                    .bytes,
                TextEncoding::JsonString,
            ),
            value: JsonValue {
                source: self
                    .reader
                    .range(spans.value_range.start, spans.value_range.end)?,
                kind: spans.kind,
            },
        })
    }
    async fn next_spans_with_key(
        &mut self,
        text: impl FnMut(&str),
    ) -> io::Result<Option<JsonFieldSpans>> {
        if self.done {
            return Ok(None);
        }
        self.reader.whitespace().await?;
        if self.reader.peek() == Some(b'}') {
            self.reader.advance(1);
            self.reader.end().await?;
            self.done = true;
            return Ok(None);
        }
        if !self.first {
            self.reader.expect(b',').await?;
            self.reader.whitespace().await?;
        }
        self.first = false;
        let key_start = self.reader.position();
        self.reader.string_with(text).await?;
        let key_end = self.reader.position();
        self.reader.whitespace().await?;
        self.reader.expect(b':').await?;
        let (start, end, kind) = self.reader.value_span().await?;
        Ok(Some(JsonFieldSpans {
            key_range: key_start..key_end,
            value_range: start..end,
            kind,
        }))
    }
}

pub struct ArrayCursor {
    reader: Reader,
    first: bool,
    done: bool,
}
impl ArrayCursor {
    pub async fn open(source: JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        let mut reader = Reader::new(source.bytes, budget).await?;
        reader.whitespace().await?;
        reader.expect(b'[').await?;
        Ok(Self {
            reader,
            first: true,
            done: false,
        })
    }
    pub async fn next(&mut self) -> io::Result<Option<JsonValue>> {
        let Some(span) = self.next_span().await? else {
            return Ok(None);
        };
        Ok(Some(JsonValue {
            source: self
                .reader
                .range(span.value_range.start, span.value_range.end)?,
            kind: span.kind,
        }))
    }
    /// Raw parent-relative offsets for an indexed array directory.
    pub async fn next_span(&mut self) -> io::Result<Option<JsonValueSpans>> {
        if self.done {
            return Ok(None);
        }
        self.reader.whitespace().await?;
        if self.reader.peek() == Some(b']') {
            self.reader.advance(1);
            self.reader.end().await?;
            self.done = true;
            return Ok(None);
        }
        if !self.first {
            self.reader.expect(b',').await?;
            self.reader.whitespace().await?;
        }
        self.first = false;
        let (start, end, kind) = self.reader.value_span().await?;
        Ok(Some(JsonValueSpans {
            value_range: start..end,
            kind,
        }))
    }
}

/// Locate a closed schema's fields in a single object traversal. Output slots
/// have the same order as `names`; the caller owns their directory accounting.
pub async fn fields(
    source: &JsonSource,
    names: &[&str],
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Vec<Option<JsonValue>>> {
    let mut output = vec![None; names.len()];
    let mut cursor = ObjectCursor::open(source.clone(), budget).await?;
    while let Some((field, selected)) = cursor.next_named_spans(names.iter().copied()).await? {
        if let Some(selected) = selected {
            let value = JsonValue {
                source: source.slice(field.value_range)?,
                kind: field.kind,
            };
            for (slot, name) in output.iter_mut().zip(names) {
                if *name == names[selected] {
                    *slot = Some(value.clone());
                }
            }
        }
    }
    Ok(output)
}

pub async fn field(
    source: &JsonSource,
    path: &[&str],
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Option<JsonValue>> {
    let mut value = JsonValue {
        source: source.clone(),
        kind: kind(source, budget.clone()).await?,
    };
    for name in path {
        if value.kind != JsonKind::Object {
            return Ok(None);
        }
        let mut found = fields(&value.source, &[*name], budget.clone()).await?;
        let Some(next) = found.pop().flatten() else {
            return Ok(None);
        };
        value = next;
    }
    Ok(Some(value))
}

pub async fn text_eq(
    source: &TextSource,
    expected: &str,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<bool> {
    let mut reader = TextReader::new(source, budget).await?;
    let mut expected = expected.as_bytes();
    while let Some(text) = reader.next().await? {
        let Some(rest) = expected.strip_prefix(text) else {
            return Ok(false);
        };
        expected = rest;
    }
    Ok(expected.is_empty())
}

struct TextReader {
    reader: Reader,
    encoding: TextEncoding,
    scalar: [u8; 4],
}
impl TextReader {
    async fn new(source: &TextSource, budget: Arc<dyn SourceBudget>) -> io::Result<Self> {
        let mut reader = Reader::new(source.bytes.clone(), budget).await?;
        if source.encoding == TextEncoding::JsonString {
            reader.expect(b'"').await?;
        }
        Ok(Self {
            reader,
            encoding: source.encoding,
            scalar: [0; 4],
        })
    }
    async fn next(&mut self) -> io::Result<Option<&[u8]>> {
        loop {
            let bytes = self.reader.remaining();
            match text_piece(bytes, self.encoding)? {
                TextPiece::Run(run) => {
                    let len = run.len();
                    self.reader.advance(len);
                    return Ok(Some(
                        &self.reader.loaded()[self.reader.at - len..self.reader.at],
                    ));
                }
                TextPiece::Escape(character, count) => {
                    self.reader.advance(count);
                    return Ok(Some(character.encode_utf8(&mut self.scalar).as_bytes()));
                }
                TextPiece::Close => {
                    self.reader.advance(1);
                    self.reader.end().await?;
                    return Ok(None);
                }
                TextPiece::Refill if bytes.is_empty() => {
                    if !self.reader.refill().await? {
                        return if self.encoding == TextEncoding::Utf8 {
                            Ok(None)
                        } else {
                            Err(syntax("truncated JSON source"))
                        };
                    }
                }
                TextPiece::Refill
                    if self.encoding == TextEncoding::JsonString && bytes[0] == b'\\' =>
                {
                    let character = self.reader.split_escape().await?;
                    return Ok(Some(character.encode_utf8(&mut self.scalar).as_bytes()));
                }
                TextPiece::Refill => {
                    let text = self.reader.split_utf8(bytes[0], &mut self.scalar).await?;
                    return Ok(Some(text.as_bytes()));
                }
            }
        }
    }
}

/// Hash decoded Unicode bytes, so literal and escaped object keys share identity.
pub async fn text_digest(
    source: &TextSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<[u8; 32]> {
    use sha2::{Digest, Sha256};
    let mut reader = TextReader::new(source, budget).await?;
    let mut digest = Sha256::new();
    while let Some(text) = reader.next().await? {
        digest.update(text);
    }
    Ok(digest.finalize().into())
}

/// Digests may select candidates; equality still compares the decoded keys.
pub async fn text_source_eq(
    left: &TextSource,
    right: &TextSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<bool> {
    Ok(text_source_cmp(left, right, budget).await? == Ordering::Equal)
}

/// Compare decoded Unicode keys without retaining either token in memory.
pub async fn text_source_cmp(
    left: &TextSource,
    right: &TextSource,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Ordering> {
    let mut left = TextReader::new(left, budget.clone()).await?;
    let mut right = TextReader::new(right, budget).await?;
    let (mut left_bytes, mut right_bytes) = (&[][..], &[][..]);
    loop {
        if left_bytes.is_empty() {
            left_bytes = left.next().await?.unwrap_or_default();
        }
        if right_bytes.is_empty() {
            right_bytes = right.next().await?.unwrap_or_default();
        }
        let count = left_bytes.len().min(right_bytes.len());
        if count == 0 {
            return Ok(left_bytes.len().cmp(&right_bytes.len()));
        }
        let order = left_bytes[..count].cmp(&right_bytes[..count]);
        if order != Ordering::Equal {
            return Ok(order);
        }
        left_bytes = &left_bytes[count..];
        right_bytes = &right_bytes[count..];
    }
}

pub async fn bool_value(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<bool> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    reader.whitespace().await?;
    let value = match reader.peek() {
        Some(b't') => {
            reader.literal(b"true").await?;
            true
        }
        Some(b'f') => {
            reader.literal(b"false").await?;
            false
        }
        _ => return Err(invalid("JSON value is not a boolean")),
    };
    reader.end().await?;
    Ok(value)
}

pub async fn u64_value(source: &JsonSource, budget: Arc<dyn SourceBudget>) -> io::Result<u64> {
    let mut reader = Reader::new(source.bytes.clone(), budget).await?;
    reader.whitespace().await?;
    let mut value = 0u64;
    let first = reader
        .peek()
        .ok_or_else(|| syntax("truncated JSON source"))?;
    reader.advance(1);
    if !first.is_ascii_digit() {
        return Err(invalid("JSON value is not an unsigned integer"));
    }
    value += u64::from(first - b'0');
    loop {
        if reader.remaining().is_empty() {
            reader.refill().await?;
        }
        let Some(byte @ b'0'..=b'9') = reader.peek() else {
            break;
        };
        if first == b'0' {
            return Err(syntax("JSON integer has a leading zero"));
        }
        reader.advance(1);
        value = value
            .checked_mul(10)
            .and_then(|value| value.checked_add(u64::from(byte - b'0')))
            .ok_or_else(|| invalid("JSON integer exceeds u64"))?;
    }
    reader.end().await?;
    Ok(value)
}

#[cfg(test)]
mod tests;
