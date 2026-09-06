//! Portable Mirrors values. Integers remain decimal strings until a native
//! adapter explicitly decodes them (the Counter uses arbitrary-precision BigInt).
use crate::strict::exact;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Type {
    Int,
    Bool,
    Str,
    Null,
    Set(Box<Type>),
    Seq(Box<Type>),
    Tuple(Vec<Type>),
    Record(BTreeMap<String, Type>),
    Map(Box<Type>),
    Variant(BTreeMap<String, Type>),
}

fn label(value: &Value) -> Result<String, String> {
    let text = value.as_str().ok_or("expected string label")?;
    if text.is_empty() || text.len() > 128 {
        return Err("invalid label length".into());
    }
    Ok(text.into())
}

impl Type {
    pub fn parse(value: &Value) -> Result<Self, String> {
        crate::strict::check_bounds(value)?;
        Self::parse_at(value, 0)
    }
    fn parse_at(value: &Value, depth: usize) -> Result<Self, String> {
        if depth > 32 {
            return Err("type depth exceeded".into());
        }
        let kind = value
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("missing type kind")?;
        let inner = |v| Self::parse_at(v, depth + 1);
        match kind {
            "int" | "bool" | "str" | "null" => {
                exact(value, &["kind"])?;
                Ok(match kind {
                    "int" => Self::Int,
                    "bool" => Self::Bool,
                    "str" => Self::Str,
                    _ => Self::Null,
                })
            }
            "set" | "seq" => {
                let object = exact(value, &["kind", "element"])?;
                let ty = Box::new(inner(&object["element"])?);
                Ok(if kind == "set" {
                    Self::Set(ty)
                } else {
                    Self::Seq(ty)
                })
            }
            "tuple" => {
                let object = exact(value, &["kind", "elements"])?;
                Ok(Self::Tuple(
                    object["elements"]
                        .as_array()
                        .ok_or("expected tuple elements")?
                        .iter()
                        .map(inner)
                        .collect::<Result<_, _>>()?,
                ))
            }
            "record" | "variant" => {
                let field_key = if kind == "record" { "fields" } else { "cases" };
                let name_key = if kind == "record" { "wireName" } else { "tag" };
                let type_key = if kind == "record" { "type" } else { "payload" };
                let object = exact(value, &["kind", field_key])?;
                let mut fields = BTreeMap::new();
                for field in object[field_key].as_array().ok_or("expected fields")? {
                    let f = exact(field, &[name_key, type_key])?;
                    if fields
                        .insert(label(&f[name_key])?, inner(&f[type_key])?)
                        .is_some()
                    {
                        return Err("duplicate field/tag".into());
                    }
                }
                if kind == "variant" && fields.is_empty() {
                    return Err("variant requires cases".into());
                }
                Ok(if kind == "record" {
                    Self::Record(fields)
                } else {
                    Self::Variant(fields)
                })
            }
            "map" => {
                let object = exact(value, &["kind", "key", "value"])?;
                if !matches!(inner(&object["key"])?, Self::Str) {
                    return Err("portable map keys must be str".into());
                }
                Ok(Self::Map(Box::new(inner(&object["value"])?)))
            }
            _ => Err("unsupported type kind".into()),
        }
    }

    /// Validate and produce a semantic comparison key; set and map order is
    /// immaterial, while sequence/tuple order and variant tags remain distinct.
    pub fn validate(&self, value: &Value) -> Result<(), String> {
        crate::strict::check_bounds(value)?;
        self.canonical(value, 0).map(|_| ())
    }
    fn canonical(&self, value: &Value, depth: usize) -> Result<String, String> {
        if depth > 32 {
            return Err("value depth exceeded".into());
        }
        let serial = |v: &Value| serde_json::to_string(v).map_err(|e| e.to_string());
        let key = match self {
            Self::Int => {
                let object = exact(value, &["#bigint"])?;
                let text = object["#bigint"]
                    .as_str()
                    .ok_or("integer requires decimal string")?;
                if !canonical_integer(text) {
                    return Err("noncanonical integer".into());
                }
                return Ok(format!("int:{text}"));
            }
            Self::Bool if value.is_boolean() => format!("bool:{}", value),
            Self::Str if value.is_string() => format!("str:{}", serial(value)?),
            Self::Null if value.is_null() => "null".into(),
            Self::Set(ty) => {
                let object = exact(value, &["#set"])?;
                let values = object["#set"].as_array().ok_or("set requires array")?;
                let mut keys = BTreeSet::new();
                for v in values {
                    if !keys.insert(ty.canonical(v, depth + 1)?) {
                        return Err("duplicate set element".into());
                    }
                }
                format!("set:{}", serde_json::to_string(&keys).unwrap())
            }
            Self::Seq(ty) => {
                let values = value.as_array().ok_or("sequence requires array")?;
                let keys = values
                    .iter()
                    .map(|v| ty.canonical(v, depth + 1))
                    .collect::<Result<Vec<_>, _>>()?;
                format!("seq:{}", serde_json::to_string(&keys).unwrap())
            }
            Self::Tuple(types) => {
                let object = exact(value, &["#tup"])?;
                let values = object["#tup"].as_array().ok_or("tuple requires array")?;
                if values.len() != types.len() {
                    return Err("tuple arity mismatch".into());
                }
                let keys = types
                    .iter()
                    .zip(values)
                    .map(|(ty, v)| ty.canonical(v, depth + 1))
                    .collect::<Result<Vec<_>, _>>()?;
                format!("tuple:{}", serde_json::to_string(&keys).unwrap())
            }
            Self::Record(fields) => {
                let object = value.as_object().ok_or("record requires object")?;
                if object.len() != fields.len() {
                    return Err("record field mismatch".into());
                }
                let mut keys = BTreeMap::new();
                for (name, ty) in fields {
                    keys.insert(
                        name,
                        ty.canonical(object.get(name).ok_or("missing record field")?, depth + 1)?,
                    );
                }
                format!("record:{}", serde_json::to_string(&keys).unwrap())
            }
            Self::Map(ty) => {
                let object = exact(value, &["#map"])?;
                let entries = object["#map"].as_array().ok_or("map requires array")?;
                let mut keys = BTreeMap::new();
                for entry in entries {
                    let pair = entry.as_array().ok_or("map entry requires pair")?;
                    if pair.len() != 2 {
                        return Err("map entry arity mismatch".into());
                    }
                    let key = pair[0].as_str().ok_or("map key requires string")?;
                    if keys
                        .insert(key, ty.canonical(&pair[1], depth + 1)?)
                        .is_some()
                    {
                        return Err("duplicate map key".into());
                    }
                }
                format!("map:{}", serde_json::to_string(&keys).unwrap())
            }
            Self::Variant(cases) => {
                let object = exact(value, &["tag", "value"])?;
                let tag = object["tag"]
                    .as_str()
                    .ok_or("variant tag requires string")?;
                let ty = cases.get(tag).ok_or("unknown variant tag")?;
                format!(
                    "variant:{}",
                    serde_json::to_string(&(tag, ty.canonical(&object["value"], depth + 1)?))
                        .unwrap()
                )
            }
            _ => return Err("value type mismatch".into()),
        };
        Ok(key)
    }
}

pub fn canonical_integer(text: &str) -> bool {
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
    use serde_json::json;
    #[test]
    fn integers_are_lossless_and_canonical() {
        for text in [
            "0",
            "9007199254740993",
            "-99999999999999999999999999999999999999999",
        ] {
            assert!(Type::Int.validate(&json!({"#bigint":text})).is_ok());
        }
        for v in [
            json!(1),
            json!({"#bigint":"-0"}),
            json!({"#bigint":"01"}),
            json!({"#bigint":"+1"}),
        ] {
            assert!(Type::Int.validate(&v).is_err());
        }
    }
    #[test]
    fn nested_sets_detect_semantic_duplicates() {
        let ty = Type::Set(Box::new(Type::Set(Box::new(Type::Str))));
        assert!(
            ty.validate(&json!({"#set":[{"#set":["a","b"]},{"#set":["b","a"]}]}))
                .is_err()
        );
    }
}
