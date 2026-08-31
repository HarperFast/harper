fn main() {
    // napi_build wires the node-api link args for the cdylib; only needed for the napi feature
    if std::env::var("CARGO_FEATURE_NAPI").is_ok() {
        napi_build::setup();
    }
}
