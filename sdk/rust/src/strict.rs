use crate::{Error, Result};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

pub const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const CONTROL_FRAME_BYTES: usize = 1_048_576;
pub const CONTROL_DEPTH: usize = 128;
pub const CONTROL_NODES: usize = 16_384;
pub const WORKER_FRAME_BYTES: usize = 65_535;
pub const WORKER_DEPTH: usize = 96;
pub const WORKER_NODES: usize = 8_192;
pub const MANIFEST_BYTES: usize = 262_144;
pub const ATTACHMENT_BYTES: usize = 4_096;

#[derive(Clone, Copy)]
pub struct Limits {
    pub bytes: usize,
    pub depth: usize,
    pub nodes: usize,
}
pub const CONTROL_LIMITS: Limits = Limits {
    bytes: CONTROL_FRAME_BYTES,
    depth: CONTROL_DEPTH,
    nodes: CONTROL_NODES,
};
pub const WORKER_LIMITS: Limits = Limits {
    bytes: WORKER_FRAME_BYTES,
    depth: WORKER_DEPTH,
    nodes: WORKER_NODES,
};
pub const MANIFEST_LIMITS: Limits = Limits {
    bytes: MANIFEST_BYTES,
    depth: WORKER_DEPTH,
    nodes: WORKER_NODES,
};
pub const ATTACHMENT_LIMITS: Limits = Limits {
    bytes: ATTACHMENT_BYTES,
    depth: CONTROL_DEPTH,
    nodes: CONTROL_NODES,
};

struct Scanner<'a> {
    text: &'a str,
    at: usize,
    nodes: usize,
    limits: Limits,
}
impl<'a> Scanner<'a> {
    fn new(text: &'a str, limits: Limits) -> Self {
        Self {
            text,
            at: 0,
            nodes: 0,
            limits,
        }
    }
    fn bytes(&self) -> &[u8] {
        self.text.as_bytes()
    }
    fn whitespace(&mut self) {
        while self
            .bytes()
            .get(self.at)
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        {
            self.at += 1;
        }
    }
    fn run(mut self) -> Result<Value> {
        self.whitespace();
        let value = self.value(0)?;
        self.whitespace();
        if self.at != self.text.len() {
            return Err(Error::protocol("trailing JSON content"));
        }
        Ok(value)
    }
    fn node(&mut self, depth: usize) -> Result<()> {
        self.nodes += 1;
        if depth > self.limits.depth || self.nodes > self.limits.nodes {
            return Err(Error::limit("JSON structural limit exceeded"));
        }
        Ok(())
    }
    fn hex(byte: u8) -> Result<u32> {
        match byte {
            b'0'..=b'9' => Ok(u32::from(byte - b'0')),
            b'a'..=b'f' => Ok(u32::from(10 + byte - b'a')),
            b'A'..=b'F' => Ok(u32::from(10 + byte - b'A')),
            _ => Err(Error::protocol("malformed Unicode escape")),
        }
    }
    fn unicode_escape(&mut self) -> Result<u32> {
        if self.at + 4 > self.text.len() {
            return Err(Error::protocol("malformed Unicode escape"));
        }
        let mut cp = 0;
        for _ in 0..4 {
            cp = (cp << 4) | Self::hex(self.bytes()[self.at])?;
            self.at += 1;
        }
        Ok(cp)
    }
    fn string(&mut self) -> Result<String> {
        if self.bytes().get(self.at) != Some(&b'"') {
            return Err(Error::protocol("expected JSON string"));
        }
        self.at += 1;
        let mut decoded = String::new();
        while let Some(&byte) = self.bytes().get(self.at) {
            self.at += 1;
            match byte {
                b'"' => return Ok(decoded),
                0..=0x1f => return Err(Error::protocol("control character in JSON string")),
                b'\\' => {
                    let escape = *self
                        .bytes()
                        .get(self.at)
                        .ok_or_else(|| Error::protocol("unterminated JSON escape"))?;
                    self.at += 1;
                    match escape {
                        b'"' => decoded.push('"'),
                        b'\\' => decoded.push('\\'),
                        b'/' => decoded.push('/'),
                        b'b' => decoded.push('\u{8}'),
                        b'f' => decoded.push('\u{c}'),
                        b'n' => decoded.push('\n'),
                        b'r' => decoded.push('\r'),
                        b't' => decoded.push('\t'),
                        b'u' => {
                            let mut cp = self.unicode_escape()?;
                            if (0xd800..=0xdbff).contains(&cp) {
                                if self.bytes().get(self.at..self.at + 2) != Some(&b"\\u"[..]) {
                                    return Err(Error::protocol("lone Unicode surrogate"));
                                }
                                self.at += 2;
                                let low = self.unicode_escape()?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return Err(Error::protocol("lone Unicode surrogate"));
                                }
                                cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
                            } else if (0xdc00..=0xdfff).contains(&cp) {
                                return Err(Error::protocol("lone Unicode surrogate"));
                            }
                            decoded.push(
                                char::from_u32(cp)
                                    .ok_or_else(|| Error::protocol("invalid Unicode scalar"))?,
                            );
                        }
                        _ => return Err(Error::protocol("invalid JSON escape")),
                    }
                }
                _ if byte.is_ascii() => decoded.push(char::from(byte)),
                _ => {
                    let start = self.at - 1;
                    let tail = &self.text[start..];
                    let ch = tail
                        .chars()
                        .next()
                        .ok_or_else(|| Error::protocol("invalid UTF-8"))?;
                    self.at = start + ch.len_utf8();
                    decoded.push(ch);
                }
            }
        }
        Err(Error::protocol("unterminated JSON string"))
    }
    fn literal(&mut self, literal: &str) -> Result<()> {
        if !self.text[self.at..].starts_with(literal) {
            return Err(Error::protocol("malformed JSON value"));
        }
        self.at += literal.len();
        Ok(())
    }
    fn number(&mut self) -> Result<Value> {
        let start = self.at;
        while self
            .bytes()
            .get(self.at)
            .is_some_and(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}' | b':'))
        {
            self.at += 1;
        }
        let canonical = exact_number(&self.text[start..self.at])?;
        if let Ok(signed) = canonical.parse::<i64>() {
            Ok(Value::Number(signed.into()))
        } else {
            Ok(Value::Number(
                canonical
                    .parse::<u64>()
                    .map_err(|_| Error::protocol("unsafe JSON integer"))?
                    .into(),
            ))
        }
    }
    fn value(&mut self, depth: usize) -> Result<Value> {
        self.node(depth)?;
        self.whitespace();
        match self
            .bytes()
            .get(self.at)
            .copied()
            .ok_or_else(|| Error::protocol("missing JSON value"))?
        {
            b'"' => Ok(Value::String(self.string()?)),
            b'{' => {
                self.at += 1;
                self.whitespace();
                let mut object = Map::new();
                if self.bytes().get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(Value::Object(object));
                }
                loop {
                    self.whitespace();
                    let key = self.string()?;
                    if object.contains_key(&key) {
                        return Err(Error::protocol("duplicate JSON object key"));
                    }
                    self.whitespace();
                    if self.bytes().get(self.at) != Some(&b':') {
                        return Err(Error::protocol("expected colon"));
                    }
                    self.at += 1;
                    let child = self.value(depth + 1)?;
                    object.insert(key, child);
                    self.whitespace();
                    match self.bytes().get(self.at) {
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Value::Object(object));
                        }
                        Some(b',') => self.at += 1,
                        _ => return Err(Error::protocol("expected object separator")),
                    }
                }
            }
            b'[' => {
                self.at += 1;
                self.whitespace();
                let mut array = Vec::new();
                if self.bytes().get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(Value::Array(array));
                }
                loop {
                    array.push(self.value(depth + 1)?);
                    self.whitespace();
                    match self.bytes().get(self.at) {
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Value::Array(array));
                        }
                        Some(b',') => self.at += 1,
                        _ => return Err(Error::protocol("expected array separator")),
                    }
                }
            }
            b't' => {
                self.literal("true")?;
                Ok(Value::Bool(true))
            }
            b'f' => {
                self.literal("false")?;
                Ok(Value::Bool(false))
            }
            b'n' => {
                self.literal("null")?;
                Ok(Value::Null)
            }
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(Error::protocol("malformed JSON value")),
        }
    }
}

pub fn parse(bytes: &[u8], limits: Limits) -> Result<Value> {
    if bytes.is_empty() {
        return Err(Error::protocol("empty JSON value"));
    }
    if bytes.len() > limits.bytes {
        return Err(Error::limit("JSON byte limit exceeded"));
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(Error::protocol("JSON BOM is forbidden"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Error::protocol("invalid UTF-8"))?;
    Scanner::new(text, limits).run()
}

pub fn encode(value: &Value, limits: Limits) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|e| Error::protocol(e.to_string()))?;
    let _ = parse(&bytes, limits)?;
    Ok(bytes)
}

pub fn exact<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| Error::protocol("expected JSON object"))?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(Error::protocol("record fields do not match contract"));
    }
    Ok(object)
}
pub fn safe_id(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|id| *id > 0 && *id <= SAFE_INTEGER)
        .ok_or_else(|| Error::protocol("invalid positive safe integer"))
}
pub fn string(value: &Value, max: usize) -> Result<&str> {
    value
        .as_str()
        .filter(|s| s.len() <= max)
        .ok_or_else(|| Error::protocol("invalid bounded string"))
}
pub fn identifier(value: &Value) -> Result<&str> {
    let text = string(value, 128)?;
    let mut bytes = text.bytes();
    if !bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        || !bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    {
        return Err(Error::protocol("invalid identifier"));
    }
    Ok(text)
}
pub fn digest(value: &Value) -> Result<&str> {
    let text = value
        .as_str()
        .ok_or_else(|| Error::protocol("invalid digest"))?;
    if text.len() != 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::protocol("invalid digest"));
    }
    Ok(text)
}
pub fn unique_strings(value: &Value, max_items: usize, max_bytes: usize) -> Result<Vec<String>> {
    let items = value
        .as_array()
        .filter(|v| v.len() <= max_items)
        .ok_or_else(|| Error::protocol("invalid bounded string list"))?;
    let mut seen = BTreeSet::new();
    let mut result = Vec::with_capacity(items.len());
    for item in items {
        let text = string(item, max_bytes)?.to_owned();
        if !seen.insert(text.clone()) {
            return Err(Error::protocol("duplicate list entry"));
        }
        result.push(text);
    }
    Ok(result)
}

fn exact_number(text: &str) -> Result<String> {
    let bytes = text.as_bytes();
    let negative = bytes.first() == Some(&b'-');
    let mut at = usize::from(negative);
    let mut digits = String::new();
    if bytes.get(at) == Some(&b'0') {
        digits.push('0');
        at += 1;
    } else {
        if !bytes.get(at).is_some_and(|b| matches!(b, b'1'..=b'9')) {
            return Err(Error::protocol("invalid JSON number"));
        }
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            digits.push(char::from(bytes[at]));
            at += 1;
        }
    }
    let mut fractional = 0_i64;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let begin = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            digits.push(char::from(bytes[at]));
            at += 1;
        }
        if at == begin {
            return Err(Error::protocol("invalid JSON fraction"));
        }
        fractional =
            i64::try_from(at - begin).map_err(|_| Error::protocol("unsafe JSON number"))?;
    }
    let mut exponent = 0_i64;
    if bytes.get(at).is_some_and(|b| matches!(b, b'e' | b'E')) {
        at += 1;
        let minus = bytes.get(at) == Some(&b'-');
        if bytes.get(at).is_some_and(|b| matches!(b, b'-' | b'+')) {
            at += 1;
        }
        let begin = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            exponent = exponent
                .saturating_mul(10)
                .saturating_add(i64::from(bytes[at] - b'0'))
                .min(1_000_001);
            at += 1;
        }
        if at == begin {
            return Err(Error::protocol("invalid JSON exponent"));
        }
        if minus {
            exponent = -exponent;
        }
    }
    if at != bytes.len() {
        return Err(Error::protocol("invalid JSON number token"));
    }
    let significant = digits.trim_start_matches('0');
    if significant.is_empty() {
        return Ok("0".into());
    }
    let scale = exponent - fractional;
    let mut integer = significant.to_owned();
    if scale < 0 {
        let remove =
            usize::try_from(-scale).map_err(|_| Error::protocol("fractional JSON number"))?;
        if remove >= integer.len()
            || !integer.as_bytes()[integer.len() - remove..]
                .iter()
                .all(|b| *b == b'0')
        {
            return Err(Error::protocol("fractional JSON number"));
        }
        integer.truncate(integer.len() - remove);
    } else {
        let add = usize::try_from(scale).map_err(|_| Error::protocol("unsafe JSON integer"))?;
        if add > 16 || integer.len() + add > 16 {
            return Err(Error::protocol("unsafe JSON integer"));
        }
        integer.extend(std::iter::repeat_n('0', add));
    }
    if integer.len() > 16
        || integer
            .parse::<u64>()
            .map_err(|_| Error::protocol("unsafe JSON integer"))?
            > SAFE_INTEGER
    {
        return Err(Error::protocol("unsafe JSON integer"));
    }
    if negative {
        integer.insert(0, '-');
    }
    Ok(integer)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_duplicate_and_unsafe_numbers() {
        assert!(parse(br#"{"a":1,"a":2}"#, CONTROL_LIMITS).is_err());
        assert!(parse(b"9007199254740992", CONTROL_LIMITS).is_err());
        assert_eq!(parse(b"1.0", CONTROL_LIMITS).unwrap(), serde_json::json!(1));
        assert_eq!(
            parse(b"10e-1", CONTROL_LIMITS).unwrap(),
            serde_json::json!(1)
        );
        assert!(parse(b"1.1", CONTROL_LIMITS).is_err());
        assert!(parse(b"1e1000001", CONTROL_LIMITS).is_err());
    }
    #[test]
    fn arbitrary_precision_magic_key_stays_an_object() {
        let value=parse(br#"{"v":{"$serde_json::private::Number":"1"},"ordinary":{"$serde_json::private::Number":"42"}}"#,CONTROL_LIMITS).unwrap();
        assert!(value["v"].is_object());
        assert!(value["ordinary"].is_object());
        assert_eq!(value["ordinary"]["$serde_json::private::Number"], "42");
    }
}
