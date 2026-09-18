use crate::{Error, Result, strict};
use num_bigint::BigInt;
use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PortableType {
    Int,
    Bool,
    Str,
    Null,
    Seq(Box<Self>),
    Set(Box<Self>),
    Tuple(Vec<Self>),
    Record(BTreeMap<String, Self>),
    Map(Box<Self>),
    Variant(BTreeMap<String, Self>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Int(BigInt),
    Bool(bool),
    Str(String),
    Null,
    Seq(Vec<Self>),
    Set(Vec<Self>),
    Tuple(Vec<Self>),
    Record(BTreeMap<String, Self>),
    Map(BTreeMap<String, Self>),
    Variant { tag: String, value: Box<Self> },
}

impl PortableType {
    pub(crate) fn parse(value: &Json) -> Result<Self> {
        Self::parse_at(value, 0)
    }
    fn parse_at(value: &Json, depth: usize) -> Result<Self> {
        if depth > 32 {
            return Err(Error::limit("portable type depth exceeded"));
        }
        let kind = value
            .get("kind")
            .and_then(Json::as_str)
            .ok_or_else(|| Error::protocol("missing portable type kind"))?;
        match kind {
            "int" | "bool" | "str" | "null" => {
                strict::exact(value, &["kind"], &[])?;
                Ok(match kind {
                    "int" => Self::Int,
                    "bool" => Self::Bool,
                    "str" => Self::Str,
                    _ => Self::Null,
                })
            }
            "seq" | "set" => {
                let object = strict::exact(value, &["kind", "element"], &[])?;
                let child = Box::new(Self::parse_at(&object["element"], depth + 1)?);
                Ok(if kind == "seq" {
                    Self::Seq(child)
                } else {
                    Self::Set(child)
                })
            }
            "tuple" => {
                let object = strict::exact(value, &["kind", "elements"], &[])?;
                let values = object["elements"]
                    .as_array()
                    .ok_or_else(|| Error::protocol("tuple elements must be array"))?;
                Ok(Self::Tuple(
                    values
                        .iter()
                        .map(|v| Self::parse_at(v, depth + 1))
                        .collect::<Result<_>>()?,
                ))
            }
            "record" | "variant" => {
                let (list, name, ty) = if kind == "record" {
                    ("fields", "wireName", "type")
                } else {
                    ("cases", "tag", "payload")
                };
                let object = strict::exact(value, &["kind", list], &[])?;
                let items = object[list]
                    .as_array()
                    .ok_or_else(|| Error::protocol("type members must be array"))?;
                let mut result = BTreeMap::new();
                for item in items {
                    let member = strict::exact(item, &[name, ty], &[])?;
                    let label = member[name]
                        .as_str()
                        .filter(|s| !s.is_empty() && s.len() <= 128)
                        .ok_or_else(|| Error::protocol("invalid type label"))?
                        .to_owned();
                    if result
                        .insert(label, Self::parse_at(&member[ty], depth + 1)?)
                        .is_some()
                    {
                        return Err(Error::protocol("duplicate type label"));
                    }
                }
                if kind == "variant" && result.is_empty() {
                    return Err(Error::protocol("variant requires a case"));
                }
                Ok(if kind == "record" {
                    Self::Record(result)
                } else {
                    Self::Variant(result)
                })
            }
            "map" => {
                let object = strict::exact(value, &["kind", "key", "value"], &[])?;
                if !matches!(Self::parse_at(&object["key"], depth + 1)?, Self::Str) {
                    return Err(Error::protocol("portable map key must be str"));
                }
                Ok(Self::Map(Box::new(Self::parse_at(
                    &object["value"],
                    depth + 1,
                )?)))
            }
            _ => Err(Error::protocol("unsupported portable type")),
        }
    }

    pub(crate) fn encode(&self, value: &Value) -> Result<Json> {
        self.encode_at(value, 0)
    }
    fn encode_at(&self, value: &Value, depth: usize) -> Result<Json> {
        if depth > 32 {
            return Err(Error::limit("portable value depth exceeded"));
        }
        match (self, value) {
            (Self::Int, Value::Int(v)) => Ok(json!({"#bigint":v.to_string()})),
            (Self::Bool, Value::Bool(v)) => Ok(json!(v)),
            (Self::Str, Value::Str(v)) => Ok(json!(v)),
            (Self::Null, Value::Null) => Ok(Json::Null),
            (Self::Seq(ty), Value::Seq(values)) => Ok(Json::Array(
                values
                    .iter()
                    .map(|v| ty.encode_at(v, depth + 1))
                    .collect::<Result<_>>()?,
            )),
            (Self::Set(ty), Value::Set(values)) => {
                let encoded = values
                    .iter()
                    .map(|v| ty.encode_at(v, depth + 1))
                    .collect::<Result<Vec<_>>>()?;
                let mut seen = BTreeSet::new();
                for item in &encoded {
                    if !seen.insert(ty.canonical(item, depth + 1)?) {
                        return Err(Error::protocol("duplicate set value"));
                    }
                }
                Ok(json!({"#set":encoded}))
            }
            (Self::Tuple(types), Value::Tuple(values)) if types.len() == values.len() => Ok(
                json!({"#tup":types.iter().zip(values).map(|(t,v)|t.encode_at(v,depth+1)).collect::<Result<Vec<_>>>()?}),
            ),
            (Self::Record(types), Value::Record(values)) if types.len() == values.len() => {
                let mut out = serde_json::Map::new();
                for (name, ty) in types {
                    out.insert(
                        name.clone(),
                        ty.encode_at(
                            values
                                .get(name)
                                .ok_or_else(|| Error::protocol("missing record field"))?,
                            depth + 1,
                        )?,
                    );
                }
                Ok(Json::Object(out))
            }
            (Self::Map(ty), Value::Map(values)) => Ok(
                json!({"#map":values.iter().map(|(k,v)|Ok(json!([k,ty.encode_at(v,depth+1)?]))).collect::<Result<Vec<Json>>>()?}),
            ),
            (Self::Variant(cases), Value::Variant { tag, value }) => {
                let ty = cases
                    .get(tag)
                    .ok_or_else(|| Error::protocol("unknown variant tag"))?;
                Ok(json!({"tag":tag,"value":ty.encode_at(value,depth+1)?}))
            }
            _ => Err(Error::protocol("portable value type mismatch")),
        }
    }

    pub(crate) fn decode(&self, value: &Json) -> Result<Value> {
        self.decode_at(value, 0)
    }
    fn decode_at(&self, value: &Json, depth: usize) -> Result<Value> {
        if depth > 32 {
            return Err(Error::limit("portable value depth exceeded"));
        }
        match self {
            Self::Int => {
                let object = strict::exact(value, &["#bigint"], &[])?;
                let text = object["#bigint"]
                    .as_str()
                    .filter(|s| canonical_integer(s))
                    .ok_or_else(|| Error::protocol("invalid bigint"))?;
                Ok(Value::Int(
                    text.parse()
                        .map_err(|_| Error::protocol("invalid bigint"))?,
                ))
            }
            Self::Bool => Ok(Value::Bool(
                value
                    .as_bool()
                    .ok_or_else(|| Error::protocol("expected bool"))?,
            )),
            Self::Str => Ok(Value::Str(
                value
                    .as_str()
                    .ok_or_else(|| Error::protocol("expected string"))?
                    .into(),
            )),
            Self::Null if value.is_null() => Ok(Value::Null),
            Self::Null => Err(Error::protocol("expected null")),
            Self::Seq(ty) => Ok(Value::Seq(
                value
                    .as_array()
                    .ok_or_else(|| Error::protocol("expected sequence"))?
                    .iter()
                    .map(|v| ty.decode_at(v, depth + 1))
                    .collect::<Result<_>>()?,
            )),
            Self::Set(ty) => {
                let object = strict::exact(value, &["#set"], &[])?;
                let array = object["#set"]
                    .as_array()
                    .ok_or_else(|| Error::protocol("expected set array"))?;
                let mut seen = BTreeSet::new();
                let mut out = Vec::new();
                for item in array {
                    if !seen.insert(ty.canonical(item, depth + 1)?) {
                        return Err(Error::protocol("duplicate set value"));
                    }
                    out.push(ty.decode_at(item, depth + 1)?);
                }
                Ok(Value::Set(out))
            }
            Self::Tuple(types) => {
                let object = strict::exact(value, &["#tup"], &[])?;
                let array = object["#tup"]
                    .as_array()
                    .filter(|a| a.len() == types.len())
                    .ok_or_else(|| Error::protocol("tuple arity mismatch"))?;
                Ok(Value::Tuple(
                    types
                        .iter()
                        .zip(array)
                        .map(|(t, v)| t.decode_at(v, depth + 1))
                        .collect::<Result<_>>()?,
                ))
            }
            Self::Record(types) => {
                let object = value
                    .as_object()
                    .filter(|o| o.len() == types.len())
                    .ok_or_else(|| Error::protocol("record field mismatch"))?;
                let mut out = BTreeMap::new();
                for (name, ty) in types {
                    out.insert(
                        name.clone(),
                        ty.decode_at(
                            object
                                .get(name)
                                .ok_or_else(|| Error::protocol("missing record field"))?,
                            depth + 1,
                        )?,
                    );
                }
                Ok(Value::Record(out))
            }
            Self::Map(ty) => {
                let object = strict::exact(value, &["#map"], &[])?;
                let entries = object["#map"]
                    .as_array()
                    .ok_or_else(|| Error::protocol("expected map entries"))?;
                let mut out = BTreeMap::new();
                for entry in entries {
                    let pair = entry
                        .as_array()
                        .filter(|p| p.len() == 2)
                        .ok_or_else(|| Error::protocol("map entry arity"))?;
                    let key = pair[0]
                        .as_str()
                        .ok_or_else(|| Error::protocol("map key must be string"))?
                        .to_owned();
                    if out
                        .insert(key, ty.decode_at(&pair[1], depth + 1)?)
                        .is_some()
                    {
                        return Err(Error::protocol("duplicate map key"));
                    }
                }
                Ok(Value::Map(out))
            }
            Self::Variant(cases) => {
                let object = strict::exact(value, &["tag", "value"], &[])?;
                let tag = object["tag"]
                    .as_str()
                    .ok_or_else(|| Error::protocol("variant tag must be string"))?
                    .to_owned();
                let ty = cases
                    .get(&tag)
                    .ok_or_else(|| Error::protocol("unknown variant tag"))?;
                Ok(Value::Variant {
                    tag,
                    value: Box::new(ty.decode_at(&object["value"], depth + 1)?),
                })
            }
        }
    }
    fn canonical(&self, value: &Json, depth: usize) -> Result<String> {
        if depth > 32 {
            return Err(Error::limit("portable value depth exceeded"));
        }
        match self {
            Self::Int => {
                let object = strict::exact(value, &["#bigint"], &[])?;
                let text = object["#bigint"]
                    .as_str()
                    .filter(|s| canonical_integer(s))
                    .ok_or_else(|| Error::protocol("invalid bigint"))?;
                Ok(format!("i:{text}"))
            }
            Self::Bool => Ok(format!(
                "b:{}",
                value
                    .as_bool()
                    .ok_or_else(|| Error::protocol("expected bool"))?
            )),
            Self::Str => Ok(format!(
                "s:{}",
                serde_json::to_string(
                    value
                        .as_str()
                        .ok_or_else(|| Error::protocol("expected string"))?
                )
                .map_err(|e| Error::protocol(e.to_string()))?
            )),
            Self::Null if value.is_null() => Ok("n".into()),
            Self::Null => Err(Error::protocol("expected null")),
            Self::Seq(ty) => Ok(format!(
                "q:{:?}",
                value
                    .as_array()
                    .ok_or_else(|| Error::protocol("expected sequence"))?
                    .iter()
                    .map(|v| ty.canonical(v, depth + 1))
                    .collect::<Result<Vec<_>>>()?
            )),
            Self::Set(ty) => {
                let object = strict::exact(value, &["#set"], &[])?;
                let mut keys = BTreeSet::new();
                for item in object["#set"]
                    .as_array()
                    .ok_or_else(|| Error::protocol("expected set array"))?
                {
                    if !keys.insert(ty.canonical(item, depth + 1)?) {
                        return Err(Error::protocol("duplicate set value"));
                    }
                }
                Ok(format!("e:{keys:?}"))
            }
            Self::Tuple(types) => {
                let object = strict::exact(value, &["#tup"], &[])?;
                let values = object["#tup"]
                    .as_array()
                    .filter(|v| v.len() == types.len())
                    .ok_or_else(|| Error::protocol("tuple arity mismatch"))?;
                Ok(format!(
                    "t:{:?}",
                    types
                        .iter()
                        .zip(values)
                        .map(|(t, v)| t.canonical(v, depth + 1))
                        .collect::<Result<Vec<_>>>()?
                ))
            }
            Self::Record(types) => {
                let object = value
                    .as_object()
                    .filter(|v| v.len() == types.len())
                    .ok_or_else(|| Error::protocol("record field mismatch"))?;
                let mut keys = BTreeMap::new();
                for (name, ty) in types {
                    keys.insert(
                        name,
                        ty.canonical(
                            object
                                .get(name)
                                .ok_or_else(|| Error::protocol("missing record field"))?,
                            depth + 1,
                        )?,
                    );
                }
                Ok(format!("r:{keys:?}"))
            }
            Self::Map(ty) => {
                let object = strict::exact(value, &["#map"], &[])?;
                let mut keys = BTreeMap::new();
                for entry in object["#map"]
                    .as_array()
                    .ok_or_else(|| Error::protocol("expected map entries"))?
                {
                    let pair = entry
                        .as_array()
                        .filter(|p| p.len() == 2)
                        .ok_or_else(|| Error::protocol("map entry arity"))?;
                    let key = pair[0]
                        .as_str()
                        .ok_or_else(|| Error::protocol("map key must be string"))?;
                    if keys
                        .insert(key, ty.canonical(&pair[1], depth + 1)?)
                        .is_some()
                    {
                        return Err(Error::protocol("duplicate map key"));
                    }
                }
                Ok(format!("m:{keys:?}"))
            }
            Self::Variant(cases) => {
                let object = strict::exact(value, &["tag", "value"], &[])?;
                let tag = object["tag"]
                    .as_str()
                    .ok_or_else(|| Error::protocol("variant tag must be string"))?;
                let ty = cases
                    .get(tag)
                    .ok_or_else(|| Error::protocol("unknown variant tag"))?;
                Ok(format!(
                    "v:{tag}:{}",
                    ty.canonical(&object["value"], depth + 1)?
                ))
            }
        }
    }
}

fn canonical_integer(text: &str) -> bool {
    if text == "0" {
        return true;
    }
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty()
        && matches!(digits.as_bytes()[0], b'1'..=b'9')
        && digits.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_sets_are_semantic() {
        let ty = PortableType::Set(Box::new(PortableType::Set(Box::new(PortableType::Int))));
        let wire = json!({"#set":[{"#set":[{"#bigint":"1"},{"#bigint":"2"}]},{"#set":[{"#bigint":"2"},{"#bigint":"1"}]}]});
        assert!(ty.decode(&wire).is_err());
        let one = Value::Set(vec![Value::Int(1.into()), Value::Int(2.into())]);
        let two = Value::Set(vec![Value::Int(2.into()), Value::Int(1.into())]);
        assert!(ty.encode(&Value::Set(vec![one, two])).is_err());
    }
}
