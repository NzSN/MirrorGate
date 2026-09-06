use mirrorgate_worker::{
    Manifest, strict,
    value::Type,
    worker::{validate_request, validate_response},
};
use serde_json::Value;

#[test]
fn shared_language_neutral_vectors() {
    let corpus = include_str!("../../../conformance/vectors.jsonl");
    let mut count = 0;
    for line in corpus.lines().filter(|line| !line.trim().is_empty()) {
        let vector: Value = serde_json::from_str(line).unwrap();
        let value = &vector["value"];
        let result = match vector["kind"].as_str().unwrap() {
            "manifest" => Manifest::parse(value).map(|_| ()),
            "value" => Type::parse(&vector["type"]).and_then(|ty| ty.validate(value)),
            "request" => validate_request(value).map(|_| ()),
            "response" => validate_response(value),
            "frame" => {
                let hex = vector["hex"].as_str().unwrap();
                let bytes: Vec<u8> = (0..hex.len())
                    .step_by(2)
                    .map(|offset| u8::from_str_radix(&hex[offset..offset + 2], 16).unwrap())
                    .collect();
                strict::frame(&bytes).map(|_| ())
            }
            other => panic!("unsupported shared vector kind {other}"),
        };
        assert_eq!(
            result.is_ok(),
            vector["valid"].as_bool().unwrap(),
            "{}: {:?}",
            vector["name"],
            result
        );
        count += 1;
    }
    assert!(
        count >= 90,
        "shared corpus unexpectedly absent or truncated"
    );
}
