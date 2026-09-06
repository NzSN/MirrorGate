use crate::{strict, value::Type};
use serde_json::Value;
use std::{collections::BTreeMap, io::Read, path::Path};

#[derive(Clone, Debug)]
pub struct Operation {
    pub id: String,
    pub inputs: BTreeMap<String, Type>,
}

#[derive(Clone, Debug)]
pub struct Manifest {
    pub interface_digest: String,
    pub initializers: BTreeMap<String, Operation>,
    pub actions: BTreeMap<String, Operation>,
    pub observations: BTreeMap<String, Type>,
}

impl Manifest {
    /// Bound file input before allocating or decoding its contents.
    pub fn load(path: impl AsRef<Path>) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(262_145)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        Self::from_bytes(&bytes)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        Self::parse(&strict::parse(bytes, 262_144)?)
    }
    pub fn parse(value: &Value) -> Result<Self, String> {
        strict::check_bounds(value)?;
        let object = strict::exact(
            value,
            &[
                "schema",
                "interfaceDigest",
                "initializers",
                "actions",
                "observations",
            ],
        )?;
        if object["schema"] != "mirrorgate.port/v1" {
            return Err("unsupported manifest schema".into());
        }
        let digest = object["interfaceDigest"].as_str().ok_or("invalid digest")?;
        if !valid_digest(digest) {
            return Err("invalid digest".into());
        }
        let initializers = operations(&object["initializers"])?;
        let actions = operations(&object["actions"])?;
        let observations = fields(&object["observations"])?;
        if initializers.is_empty() || observations.is_empty() {
            return Err("initializer and observation required".into());
        }
        if initializers.keys().any(|id| actions.contains_key(id)) {
            return Err("action/initializer ID collision".into());
        }
        Ok(Self {
            interface_digest: digest.into(),
            initializers,
            actions,
            observations,
        })
    }
    pub fn operation(&self, id: &str) -> Option<&Operation> {
        self.initializers.get(id).or_else(|| self.actions.get(id))
    }
    pub fn validate_observations(&self, value: &Value) -> Result<(), String> {
        validate_fields(&self.observations, value)
    }
}

impl Operation {
    pub fn validate_inputs(&self, value: &Value) -> Result<(), String> {
        validate_fields(&self.inputs, value)
    }
}

fn validate_fields(fields: &BTreeMap<String, Type>, value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("expected keyed values")?;
    if object.len() != fields.len() {
        return Err("value field mismatch".into());
    }
    for (name, ty) in fields {
        ty.validate(object.get(name).ok_or("missing value field")?)?;
    }
    Ok(())
}

fn fields(value: &Value) -> Result<BTreeMap<String, Type>, String> {
    let mut result = BTreeMap::new();
    for field in value.as_array().ok_or("expected fields array")? {
        let object = strict::exact(field, &["id", "type"])?;
        let id = strict::identifier(&object["id"])?;
        if result
            .insert(id.into(), Type::parse(&object["type"])?)
            .is_some()
        {
            return Err("duplicate field ID".into());
        }
    }
    Ok(result)
}

fn operations(value: &Value) -> Result<BTreeMap<String, Operation>, String> {
    let mut result = BTreeMap::new();
    for operation in value.as_array().ok_or("expected operations array")? {
        let object = strict::exact(operation, &["id", "inputs"])?;
        let id = strict::identifier(&object["id"])?;
        let op = Operation {
            id: id.into(),
            inputs: fields(&object["inputs"])?,
        };
        if result.insert(id.into(), op).is_some() {
            return Err("duplicate operation ID".into());
        }
    }
    Ok(result)
}

pub fn valid_digest(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
