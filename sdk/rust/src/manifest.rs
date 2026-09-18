use crate::{Error, PortableType, Result, Value, strict};
use serde_json::{Map, Value as Json};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct OperationSpec {
    pub id: String,
    pub inputs: BTreeMap<String, PortableType>,
}

#[derive(Clone, Debug)]
pub struct PublicManifest {
    exact_json: String,
    interface_digest: String,
    initializers: BTreeMap<String, OperationSpec>,
    actions: BTreeMap<String, OperationSpec>,
    observations: BTreeMap<String, PortableType>,
}

impl PublicManifest {
    pub fn from_exact_json(exact_json: &str) -> Result<Self> {
        let document = strict::parse(exact_json.as_bytes(), strict::MANIFEST_LIMITS)?;
        let mut result = Self::from_json(&document)?;
        result.exact_json = exact_json.into();
        Ok(result)
    }
    pub(crate) fn from_json(value: &Json) -> Result<Self> {
        let object = strict::exact(
            value,
            &[
                "schema",
                "interfaceDigest",
                "initializers",
                "actions",
                "observations",
            ],
            &[],
        )?;
        if object["schema"] != "mirrorgate.port/v1" {
            return Err(Error::protocol("unsupported manifest schema"));
        }
        let digest = strict::digest(&object["interfaceDigest"])?.to_owned();
        let initializers = operations(&object["initializers"])?;
        let actions = operations(&object["actions"])?;
        let observations = fields(&object["observations"])?;
        if initializers.is_empty()
            || observations.is_empty()
            || initializers.keys().any(|id| actions.contains_key(id))
        {
            return Err(Error::protocol("invalid manifest operation inventory"));
        }
        Ok(Self {
            exact_json: String::new(),
            interface_digest: digest,
            initializers,
            actions,
            observations,
        })
    }
    #[must_use]
    pub fn exact_json(&self) -> &str {
        &self.exact_json
    }
    #[must_use]
    pub fn interface_digest(&self) -> &str {
        &self.interface_digest
    }
    #[must_use]
    pub fn is_initializer(&self, id: &str) -> bool {
        self.initializers.contains_key(id)
    }
    pub(crate) fn encode_inputs(&self, id: &str, values: &BTreeMap<String, Value>) -> Result<Json> {
        let operation = self
            .initializers
            .get(id)
            .or_else(|| self.actions.get(id))
            .ok_or_else(|| Error::protocol("unknown operation"))?;
        if values.len() != operation.inputs.len() {
            return Err(Error::protocol("input field mismatch"));
        }
        let mut out = Map::new();
        for (name, ty) in &operation.inputs {
            out.insert(
                name.clone(),
                ty.encode(
                    values
                        .get(name)
                        .ok_or_else(|| Error::protocol("missing input"))?,
                )?,
            );
        }
        Ok(Json::Object(out))
    }
    pub(crate) fn decode_observations(&self, value: &Json) -> Result<BTreeMap<String, Value>> {
        let object = value
            .as_object()
            .filter(|o| o.len() == self.observations.len())
            .ok_or_else(|| Error::protocol("observation field mismatch"))?;
        let mut out = BTreeMap::new();
        for (name, ty) in &self.observations {
            out.insert(
                name.clone(),
                ty.decode(
                    object
                        .get(name)
                        .ok_or_else(|| Error::protocol("missing observation"))?,
                )?,
            );
        }
        Ok(out)
    }
}

fn fields(value: &Json) -> Result<BTreeMap<String, PortableType>> {
    let mut result = BTreeMap::new();
    for field in value
        .as_array()
        .ok_or_else(|| Error::protocol("fields must be array"))?
    {
        let object = strict::exact(field, &["id", "type"], &[])?;
        let id = strict::identifier(&object["id"])?.to_owned();
        if result
            .insert(id, PortableType::parse(&object["type"])?)
            .is_some()
        {
            return Err(Error::protocol("duplicate field ID"));
        }
    }
    Ok(result)
}
fn operations(value: &Json) -> Result<BTreeMap<String, OperationSpec>> {
    let mut result = BTreeMap::new();
    for operation in value
        .as_array()
        .ok_or_else(|| Error::protocol("operations must be array"))?
    {
        let object = strict::exact(operation, &["id", "inputs"], &[])?;
        let id = strict::identifier(&object["id"])?.to_owned();
        let spec = OperationSpec {
            id: id.clone(),
            inputs: fields(&object["inputs"])?,
        };
        if result.insert(id, spec).is_some() {
            return Err(Error::protocol("duplicate operation ID"));
        }
    }
    Ok(result)
}
