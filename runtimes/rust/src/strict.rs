//! Bounded JSON parser that rejects duplicate object keys before normalization.
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::cell::Cell;
use std::fmt;

pub const MAX_FRAME_BYTES: usize = 65_535;
pub const MAX_NODES: usize = 8_192;
pub const MAX_WIRE_DEPTH: usize = 96;

/// Apply the same aggregate limits to values constructed by native callbacks.
pub fn check_bounds(value: &Value) -> Result<(), String> {
    let mut stack = vec![(value, 0)];
    let mut nodes = 0;
    while let Some((value, depth)) = stack.pop() {
        nodes += 1;
        if depth > MAX_WIRE_DEPTH || nodes > MAX_NODES {
            return Err("JSON resource limit exceeded".into());
        }
        match value {
            Value::Array(values) => {
                if values.len() + stack.len() + nodes > MAX_NODES {
                    return Err("JSON node limit exceeded".into());
                }
                stack.extend(values.iter().map(|value| (value, depth + 1)));
            }
            Value::Object(values) => {
                if values.len() + stack.len() + nodes > MAX_NODES {
                    return Err("JSON node limit exceeded".into());
                }
                stack.extend(values.values().map(|value| (value, depth + 1)));
            }
            Value::Number(number) => {
                if !number
                    .as_i64()
                    .is_some_and(|v| v.unsigned_abs() <= 9_007_199_254_740_991)
                {
                    return Err("JSON numbers must be safe integers".into());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

struct Seed<'a> {
    nodes: &'a Cell<usize>,
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if self.depth > MAX_WIRE_DEPTH || self.nodes.get() >= MAX_NODES {
            return Err(de::Error::custom("JSON resource limit exceeded"));
        }
        self.nodes.set(self.nodes.get() + 1);
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded JSON with unique object keys")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        if v.unsigned_abs() > 9_007_199_254_740_991 {
            return Err(E::custom("unsafe JSON integer"));
        }
        Ok(Value::Number(v.into()))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        if v > 9_007_199_254_740_991 {
            return Err(E::custom("unsafe JSON integer"));
        }
        Ok(Value::Number(v.into()))
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Value, E> {
        Err(E::custom("nonintegral JSON number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(v) = seq.next_element_seed(Seed {
            nodes: self.nodes,
            depth: self.depth + 1,
        })? {
            values.push(v);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            let value = map.next_value_seed(Seed {
                nodes: self.nodes,
                depth: self.depth + 1,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

pub fn parse(bytes: &[u8], max_bytes: usize) -> Result<Value, String> {
    if bytes.len() > max_bytes {
        return Err("JSON byte limit exceeded".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "invalid UTF-8")?;
    // Normalize exact decimal tokens before serde can round them through f64.
    // Tagged model integers are strings and are never touched by this pass.
    let normalized = normalize_numbers(text)?;
    let mut decoder = serde_json::Deserializer::from_str(&normalized);
    let nodes = Cell::new(0);
    let value = Seed {
        nodes: &nodes,
        depth: 0,
    }
    .deserialize(&mut decoder)
    .map_err(|e| e.to_string())?;
    decoder.end().map_err(|e| e.to_string())?;
    Ok(value)
}

pub fn frame(bytes: &[u8]) -> Result<Value, String> {
    if bytes.last() != Some(&b'\n')
        || bytes.contains(&b'\r')
        || bytes[..bytes.len() - 1].contains(&b'\n')
    {
        return Err("frame requires exactly one LF terminator and no CR".into());
    }
    let value = parse(&bytes[..bytes.len() - 1], MAX_FRAME_BYTES)?;
    if !value.is_object() {
        return Err("frame must be an object".into());
    }
    Ok(value)
}

fn normalize_numbers(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut result = String::with_capacity(text.len());
    let mut at = 0;
    let mut start = 0;
    while at < bytes.len() {
        if bytes[at] == b'"' {
            at += 1;
            while at < bytes.len() {
                match bytes[at] {
                    b'\\' => at = (at + 2).min(bytes.len()),
                    b'"' => {
                        at += 1;
                        break;
                    }
                    _ => at += 1,
                }
            }
        } else if bytes[at].is_ascii_digit() || bytes[at] == b'-' {
            result.push_str(&text[start..at]);
            let number_start = at;
            while at < bytes.len()
                && !matches!(
                    bytes[at],
                    b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}' | b':' | b'[' | b'{' | b'"'
                )
            {
                at += 1;
            }
            result.push_str(&exact_number(&text[number_start..at])?);
            start = at;
        } else {
            at += 1;
        }
    }
    result.push_str(&text[start..]);
    Ok(result)
}

fn exact_number(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut at = usize::from(bytes.first() == Some(&b'-'));
    let negative = at == 1;
    let mut digits = String::new();
    if bytes.get(at) == Some(&b'0') {
        digits.push('0');
        at += 1;
    } else {
        if !bytes.get(at).is_some_and(|b| matches!(b, b'1'..=b'9')) {
            return Err("invalid JSON number".into());
        }
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            digits.push(bytes[at] as char);
            at += 1;
        }
    }
    let mut fractional = 0_i64;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let begin = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            digits.push(bytes[at] as char);
            at += 1;
        }
        if at == begin {
            return Err("invalid JSON fraction".into());
        }
        fractional = (at - begin) as i64;
    }
    let mut exponent = 0_i64;
    if bytes.get(at).is_some_and(|b| *b == b'e' || *b == b'E') {
        at += 1;
        let minus = bytes.get(at) == Some(&b'-');
        if bytes.get(at).is_some_and(|b| *b == b'-' || *b == b'+') {
            at += 1;
        }
        let begin = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            // Beyond this bound, no nonzero token in a bounded frame can be a
            // safe integral value. Saturation avoids unbounded exponent work.
            exponent = (exponent * 10 + i64::from(bytes[at] - b'0')).min(1_000_000);
            at += 1;
        }
        if at == begin {
            return Err("invalid JSON exponent".into());
        }
        if minus {
            exponent = -exponent;
        }
    }
    if at != bytes.len() {
        return Err("invalid JSON number token".into());
    }
    let significant = digits.trim_start_matches('0');
    if significant.is_empty() {
        return Ok("0".into());
    }
    let scale = exponent - fractional;
    let mut integer = significant.to_owned();
    if scale < 0 {
        let remove = (-scale) as usize;
        if remove > integer.len()
            || !integer.as_bytes()[integer.len() - remove..]
                .iter()
                .all(|b| *b == b'0')
        {
            return Err("JSON number is not exactly integral".into());
        }
        integer.truncate(integer.len() - remove);
    } else {
        if integer.len() as i64 + scale > 16 {
            return Err("unsafe JSON integer".into());
        }
        integer.extend(std::iter::repeat_n('0', scale as usize));
    }
    if integer.len() > 16
        || integer.parse::<u64>().map_err(|_| "unsafe JSON integer")? > 9_007_199_254_740_991
    {
        return Err("unsafe JSON integer".into());
    }
    if negative {
        integer.insert(0, '-');
    }
    Ok(integer)
}

pub fn exact<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let object = value.as_object().ok_or("expected object")?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err("unexpected or missing object field".into());
    }
    Ok(object)
}

pub fn identifier(value: &Value) -> Result<&str, String> {
    let s = value.as_str().ok_or("expected identifier")?;
    if s.is_empty()
        || s.len() > 128
        || !s.as_bytes()[0].is_ascii_alphabetic()
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
    {
        return Err("invalid identifier".into());
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_duplicate_keys_and_bad_frames() {
        assert!(frame(b"{\"a\":1,\"a\":2}\n").is_err());
        assert!(frame(b"{\"a\":{\"b\":1,\"b\":2}}\n").is_err());
        assert!(frame(b"{}\r\n").is_err());
        assert!(frame(b"{}").is_err());
        assert!(frame(b"\xff\n").is_err());
        assert!(frame(b"").is_err());
    }

    #[test]
    fn resource_boundaries_apply_to_wire_and_native_values() {
        let at_limit = format!("{{\"x\":\"{}\"}}\n", "a".repeat(MAX_FRAME_BYTES - 8));
        assert_eq!(at_limit.len(), MAX_FRAME_BYTES + 1);
        assert!(frame(at_limit.as_bytes()).is_ok());
        let over_limit = format!("{{\"x\":\"{}\"}}\n", "a".repeat(MAX_FRAME_BYTES - 7));
        assert!(frame(over_limit.as_bytes()).is_err());
        let at_nodes = serde_json::json!({"x":vec![Value::Null; MAX_NODES - 2]});
        assert!(check_bounds(&at_nodes).is_ok());
        let over_nodes = serde_json::json!({"x":vec![Value::Null; MAX_NODES - 1]});
        assert!(check_bounds(&over_nodes).is_err());
        let nested = format!("{{\"x\":{}0{}}}\n", "[".repeat(95), "]".repeat(95));
        assert!(frame(nested.as_bytes()).is_ok());
        let too_deep = format!("{{\"x\":{}0{}}}\n", "[".repeat(96), "]".repeat(96));
        assert!(frame(too_deep.as_bytes()).is_err());
    }
}
