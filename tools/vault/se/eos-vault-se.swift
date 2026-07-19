// eos-vault-se - Secure Enclave keystore helper for the 2FA vault daemon.
// Uses CryptoKit SecureEnclave.P256: the private key is generated INSIDE the
// Enclave and never leaves it. We persist only its `dataRepresentation`, an
// SE-wrapped blob that is non-extractable and useless on any other machine (a
// disk image / backup / DB dump cannot decrypt it: red-team T3). This approach
// needs NO keychain and NO entitlement (the keychain-access-groups path gets
// AMFI-killed without a provisioning profile). NO biometric gate, so the daemon
// decrypts unattended (accepted residual: a fully-owned live host can ask the SE
// to decrypt). ECIES = ephemeral ECDH to the SE key + HKDF-SHA256 + AES-256-GCM.
// Plaintext travels on stdin/stdout, never argv. Design: docs/security/2fa-...md s9.
import Foundation
import CryptoKit

func die(_ m: String) -> Never {
    FileHandle.standardError.write(("ERROR: " + m + "\n").data(using: .utf8)!); exit(1)
}

let SALT = "au.ecodia.vault.hkdf.v1".data(using: .utf8)!
let INFO = "eos-vault-se-ecies-p256-aesgcm".data(using: .utf8)!

func loadOrCreate(_ path: String) -> SecureEnclave.P256.KeyAgreement.PrivateKey {
    guard SecureEnclave.isAvailable else { die("Secure Enclave not available on this machine") }
    let url = URL(fileURLWithPath: path)
    if FileManager.default.fileExists(atPath: path) {
        do {
            let blob = try Data(contentsOf: url)
            return try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob)
        } catch { die("load SE key: \(error)") }
    }
    do {
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey()
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try key.dataRepresentation.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
        return key
    } catch { die("create SE key: \(error)") }
}

func deriveKey(_ shared: SharedSecret) -> SymmetricKey {
    shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: SALT, sharedInfo: INFO, outputByteCount: 32)
}

func seal(_ se: SecureEnclave.P256.KeyAgreement.PrivateKey, _ pt: Data) -> Data {
    let eph = P256.KeyAgreement.PrivateKey()
    do {
        let shared = try eph.sharedSecretFromKeyAgreement(with: se.publicKey)
        let box = try AES.GCM.seal(pt, using: deriveKey(shared))
        return eph.publicKey.x963Representation + box.combined!   // 65-byte (0x04||X||Y) ephemeral pub || iv+ct+tag
    } catch { die("seal: \(error)") }
}

func open(_ se: SecureEnclave.P256.KeyAgreement.PrivateKey, _ ct: Data) -> Data {
    guard ct.count > 65 else { die("ciphertext too short") }
    let ephRaw = ct.prefix(65)
    let rest = ct.suffix(from: ct.index(ct.startIndex, offsetBy: 65))
    do {
        let ephPub = try P256.KeyAgreement.PublicKey(x963Representation: ephRaw)
        let shared = try se.sharedSecretFromKeyAgreement(with: ephPub)
        let box = try AES.GCM.SealedBox(combined: rest)
        return try AES.GCM.open(box, using: deriveKey(shared))
    } catch { die("open: \(error)") }
}

let args = CommandLine.arguments
guard args.count >= 3 else { die("usage: eos-vault-se <provision|pubkey|seal|open> <keyfile>") }
let cmd = args[1], keyfile = args[2]

switch cmd {
case "provision":
    let k = loadOrCreate(keyfile)
    print(k.publicKey.rawRepresentation.base64EncodedString())
case "pubkey":
    guard FileManager.default.fileExists(atPath: keyfile) else { die("not provisioned") }
    print(loadOrCreate(keyfile).publicKey.rawRepresentation.base64EncodedString())
case "seal":
    let k = loadOrCreate(keyfile)
    let pt = FileHandle.standardInput.readDataToEndOfFile()
    print(seal(k, pt).base64EncodedString())
case "open":
    guard FileManager.default.fileExists(atPath: keyfile) else { die("not provisioned") }
    let k = loadOrCreate(keyfile)
    let raw = FileHandle.standardInput.readDataToEndOfFile()
    let b64 = String(data: raw, encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let ct = Data(base64Encoded: b64) else { die("bad base64 ciphertext") }
    FileHandle.standardOutput.write(open(k, ct))
default:
    die("unknown command '\(cmd)'")
}
