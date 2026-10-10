# ADR-13: Güvenilir Dış İnsan Kimliği ve Onay Sağlayıcısı Mimarisi (P18-04 / Trusted Identity Context)

- **Durum:** KABUL EDİLDİ (Mimari Sözleşme & Fail-Closed Güvenlik Kilidi)
- **Tarih:** 2026-10-10
- **Bağlam:** OM-04 / P18-04 (Trusted Identity Context), ADR-06 (Fail-Closed Güvenlik ve Güvenilir İnsan Onayı Sınırı) ve OM-05 / P20 Check 6 (`6_PRODUCT_OWNER_APPROVAL`).

---

## 1. Bağlam ve Problem Tanımı

ADR-06 ile OtonomMCP bünyesinde şu temel kural kayıt altına alınmıştır:
> *Antigravity IDE içindeki sohbet veya istemci beyanları (`isTrustedHumanAuth: true`, `actor: "USER"`) güvenilir insan onayı kanıtı sayılamaz. Bağımsız ve güvenilir bir dış kimlik doğrulaması bulunmadığı sürece insan onayı gerektiren tüm işlemler fail-closed olarak `BLOCKED_ON_AUTH_CONTEXT` durumunda bekletilecektir.*

Uygulayıcı model veya aracılık eden MCP istemcisi aradaki bant içi (in-band) kanaldadır. LLM veya istemci tarafından üretilen JSON alanlarının (ör. boolean bayraklar, sahte `actorRole: "PRODUCT_OWNER"` beyanları) doğrulanmamış kabul edilmesi bir ayrıcalık yükseltme (privilege escalation) açığı doğurur.

Bu nedenle, insan onayı gerektiren hassas işlemlerin (`REQUIRE_HUMAN_APPROVAL`, plan onayları, mande dışı eylemler vb.) güvenli bir şekilde yetkilendirilebilmesi için **gerçek bir dış kimlik sağlayıcısına (External Identity Provider - IdP)** bağlanabilecek açık, genişletilebilir ve sıfır güven (Zero-Trust) ilkelerine dayalı bir adaptör sözleşmesi tasarlanmalıdır.

---

## 2. Kimlik Sağlayıcısı Seçenekleri ve Güvenlik Analizi

OtonomMCP ekosisteminde değerlendirilen kimlik sağlayıcı mimarileri ve güvenlik etkileri aşağıda karşılaştırılmıştır:

| Kriter | 1. OIDC / OAuth 2.0 (JWKS + FIDO2/WebAuthn) | 2. mTLS (Client Certificates / HSM) | 3. İşletim Sistemi Biyometrik (Windows Hello / Touch ID) | 4. Yerel Dosya / DPAPI (Mevcut Temel Test Double) |
| :--- | :--- | :--- | :--- | :--- |
| **Bağımsız Güven Sınırı** | **Çok Yüksek:** Dış IdP (Keycloak, Okta, Google Workspace, Azure AD) bağımsız imzalama anahtarı (JWKS) ile doğrulanır. | **Çok Yüksek:** Özel CA ve donanımsal token (YubiKey / HSM) ile kanal ve kimlik doğrulaması. | **Yüksek:** Yerel donanım çipine (TPM/Secure Enclave) bağlı biyometrik insan varlığı kanıtı. | **Düşük (Yetersiz):** Süreçle aynı OS kullanıcısı yetkisinde çalışan zararlı Node scriptleri anahtara erişebilir. |
| **İnsan Varlığı Doğrulaması** | **Mükemmel:** FIDO2 / Passkey / WebAuthn ile bant dışı fiziksel dokunuş veya PIN şart koşulabilir. | **Orta:** Sertifika dosya sisteminde tutulursa insan varlığı yerine makine kimliği kanıtlar. | **Mükemmel:** Fiziksel biyometrik doğrulama doğrudan kullanıcıyı teyit eder. | **Yok:** Yalnızca makinede dosya okuma kabiliyetini gösterir, insanı doğrulamaz. |
| **Bağlam Bağlama (Context Binding)** | **Mükemmel:** JWT talepleri içine `projectId`, `packageId`, `revision`, `contextFingerprint`, `nonce` kriptografik olarak mühürlenir. | **Orta:** Sertifika sabittir; bağlamın mTLS üzerinden uygulama düzeyinde imzalanması gerekir. | **İyi:** Challenge-response içine bağlam parmak izi eklenebilir. | **Kısıtlı:** Yerel hash imzalaması yapılır, ancak dış otorite yoktur. |
| **Platform Bağımsızlığı & Dağıtık Yapı** | **Mükemmel:** Web, CLI, IDE ve uzak sunucu/container ortamlarında standart HTTP/JSON ile çalışır. | **Yüksek:** Standart X.509, ancak sertifika dağıtımı ve yönetimi karmaşıktır. | **Düşük:** OS'e özel API'ler gerektirir; container veya uzak sunucuda çalışamaz. | **Düşük:** Windows DPAPI yalnızca yerel Windows'ta çalışır, Linux/macOS desteği yoktur. |
| **Replay & İptal (Revocation)** | **Çok Güçlü:** `jti`/`nonce` tek kullanımlılık, kısa `exp` (ör. 5 dk) ve IdP revocation listesi. | **Güçlü:** CRL ve OCSP ile iptal, ancak gecikme ve önbellek riskleri mevcuttur. | **Güçlü:** Yerel oturum süresi. | **Zayıf:** Yerel iptal dosyası silinirse takip edilemez. |

### Karşılaştırma Sonucu ve Mimari Tercih:
1. **Hedef Üretim Standardı:** Dağıtık insan onayları ve bant dışı güvenilir onay akışları için **OpenID Connect (OIDC) / WebAuthn Passkey Token Mimarisi** ana sağlayıcı olarak seçilmiştir.
2. **Kurumsal / Makine Güven Standardı:** Sunucular arası veya katı sıfır güven kurumsal ortamlarda **mTLS İstemci Sertifikası Doğrulaması** desteklenmelidir.
3. **Mevcut Yerel DPAPI ve Bellek İçi Yapılar:** Yalnızca **Test Double (`TestDoubleIdentityProviderAdapter`)** veya geliştirme prototipi olarak sınıflandırılmıştır; üretim güvenliği kanıtı sayılamaz.

---

## 3. Güvenilir Kimlik Sözleşmesi (The Trusted Identity Contract)

`packages/core/src/authorization/` altında oluşturulan sözleşme şu katı kuralları dayatır:

### 3.1. Adaptör Arayüzü (`ITrustedIdentityProvider`)
```typescript
export interface ITrustedIdentityProvider {
  readonly providerId: string;
  readonly providerType: 'OIDC' | 'MTLS' | 'WEBAUTHN' | 'LOCAL_TEST_DOUBLE' | 'UNCONFIGURED';
  isConfigured(): boolean;
  getHealth(): Promise<TrustedProviderHealth>;
  verifyAssertion(
    assertion: TrustedIdentityAssertion,
    expectedBinding: TrustedApprovalBinding
  ): Promise<IdentityVerificationResult>;
}
```

### 3.2. Kriptografik İmza Doğrulama, Algoritma Kısıtlaması ve JWKS Ağ Güvenliği (Signature & Network Hardening)
- `jwksUri` ya da `publicKeyPem` tanımlı olması tek başına yeterli kabul edilmez.
- Gerçek kriptografik imza doğrulayıcısı (Node `crypto.verify` veya asenkron JWKS resolver) bulunmuyorsa doğrulama `CONFIG_MISSING` / `BLOCKED_ON_AUTH_CONTEXT` ile reddedilir.
- Yalnızca asimetrik algoritmalar (`RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512`, `EdDSA`) kabul edilir. `alg: none` ve simetrik `HS256`/`HS384`/`HS512` algoritmaları doğrudan reddedilir (`SIGNATURE_INVALID`).
- **JWK ve Algoritma Uyumu:** JWK içerisindeki anahtar türü (`kty`) ile algoritma (`alg`) tam uyumlu olmalıdır (`RS*` -> `RSA`, `ES*` -> `EC`, `EdDSA` -> `OKP` veya `EC`). Ayrıca token başlığındaki `alg` ile JWK üzerindeki `alg` uyuşmak zorundadır; uyuşmazlıklar fail-closed reddedilir.
- **JWKS SSRF ve DNS Rebinding Savunması:**
  - `jwksUri` kesinlikle `https://` protokolünü kullanmalıdır; `http://` fail-closed reddedilir.
  - URL içinde gömülü kullanıcı bilgisi (`username:password@`) bulunması yasaktır.
  - Standart dışı portlar engellenir (yalnızca 443 veya varsayılan HTTPS portu).
  - **DNS Ön Doğrulaması:** JWKS host adı bağlantı öncesinde tüm A ve AAAA kayıtları taranarak çözümlenir (`dns.promises.lookup`). Çözümlenen IP adreslerinden herhangi biri Loopback (`127.0.0.0/8`, `::1`), RFC1918 özel ağlar (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), Link-local ve bulut metadata adresleri (`169.254.0.0/16`, `169.254.169.254`), Carrier-grade NAT (`100.64.0.0/10`), Multicast veya ayrılmış adresler kapsamındaysa istek anında reddedilir.
  - **Uçuş Sırası (In-Flight) Soket Koruması & DNS Rebinding Engeli:** DNS TTL manipülasyonu veya TOCTOU (Time-of-check to time-of-use) tabanlı DNS rebinding saldırılarını önlemek için, HTTP istemcisi `node:https.request` seviyesinde özel `lookup` callback'i (`ssrfGuardedLookup`) ile donatılmıştır. TLS soketi bağlanırken çözümlenen IP adresi soket açılmadan hemen önce doğrulanır; izin verilmeyen IP tespit edildiğinde bağlantı anında kesilir ve fail-closed durulur.
  - **Yönlendirme (Redirect) Engeli:** HTTP 3xx yönlendirmeleri (`redirect: 'manual'`) takip edilmez; yönlendirme yanıtı dönen sağlayıcılar fail-closed olarak `PROVIDER_OUTAGE` ile reddedilir.

### 3.3. Doğrulanmış Payload'dan Yetkili Claim Çıkarımı (Authoritative Claims Extraction)
- İstemcinin ayrı gönderdiği `assertion.claims` alanı kimlik kanıtı olarak asla kabul edilmez.
- `sub`, `iss`, `aud`, `actorRole`, `exp`, `iat`, `nbf`, `nonce` alanları kriptografik olarak imzalanmış JWT payload'ı çözülerek oluşturulur.
- İstemci beyanı ile imzalı token içeriği uyuşmazsa istek `UNVERIFIED` ile fail-closed reddedilir.
- `actorRole` yalnızca `PRODUCT_OWNER` veya `USER` olabilir; `DIRECTOR` ve `EXECUTOR` aktörleri onay veremez.

### 3.4. Zorunlu ve Fail-Closed Kapsam Bağlama (Cryptographic Scope Binding)
Her onay talebi (`TrustedApprovalBinding`), imzalı JWT payload'ı içinde doğrulanmalıdır:
- `projectId`: Onayın ait olduğu kanonik proje kimliği. Başka bir projenin onayıyla işlem yapılamaz.
- `packageId` ve `revision`: Approval package'ın kesin kimliği ve revizyon numarası.
- `contextFingerprint`: Onay verildiği andaki Director Context Snapshot mantıksal parmak izi.
- `directorSessionId`: Beklenen bağlamda veya token'da tanımlıysa birebir eşleşmelidir; token'da eksikse veya uyuşmuyorsa fail-closed `BINDING_MISMATCH` üretilir.
- `taskId`: Beklenen bağlamda veya token'da tanımlıysa birebir eşleşmelidir; token'da eksikse veya uyuşmuyorsa fail-closed `BINDING_MISMATCH` üretilir.
- `operation`: Beklenen bağlamda veya token'da tanımlıysa birebir eşleşmelidir; token'da eksikse veya uyuşmuyorsa fail-closed `BINDING_MISMATCH` üretilir.
- **İstemci Binding Bağımsızlığı:** İstemcinin gönderdiği `assertion.binding` nesnesi asla imzalı token payload'ının veya beklenen yürütme bağlamının yerine geçemez. İstemci binding'i doğru görünse bile imzalı token payload'ı eksik veya uyuşmazsa talep derhal reddedilir.
- Beklenen yürütme bağlamıyla tek bir alan dahi uyuşmazsa `BINDING_MISMATCH` ile fail-closed durulur.

### 3.5. Replay ve Çok Süreçli Atomik Nonce Tüketimi (OS Kernel SQLite Kilitleri ve Bellek Yönetimi)
- Her onay iddiası zorunlu bir `nonce` (veya `jti`) içermelidir (en az 8 karakter).
- **İşletim Sistemi Çekirdeği Kilit Sözleşmesi (OS Byte-Range File Locking):**
  - Dosya sistemi tabanlı manuel süre eşikli kilitler (`staleThresholdMs = 4000ms`) yarış koşullarına ve uzun süren süreçlerin kilitlerinin çalınmasına yol açabilir.
  - Bu nedenle `NonceStore`, kilit koordinasyonunu işletim sistemi çekirdeği tarafından garanti edilen SQLite transaction kilit mekanizmasına (`DatabaseSync` ile `BEGIN EXCLUSIVE` ve `PRAGMA busy_timeout = 0`) devretmiştir.
  - Windows üzerinde `LockFileEx`, POSIX sistemlerinde fcntl/flock çekirdek düzeyinde dosya kilitlerini kullanır.
- **Süreç İçi (In-Process) Mutex Kilit Kuyruğu Temizliği (`withInProcessLock`):**
  - Aynı dosya yoluna eşzamanlı gelen işlemler `tailPromise` ile sıralı zincirlenir (`promise.then(fn, fn)`).
  - Kuyruk promise kimliği doğru izlenir; işlem tamamlandığında (`then` ve `catch` sonrasında) kuyruk kuyruk başı ile eşleştiğinde `inProcessLockQueues` haritasından kaydı silinir.
  - Farklı dosya yolları üzerinde tamamlanan operasyonlar sonrasında sıfır bellek sızıntısı (zero leak) ve güvenli temizlik garanti edilir. Hatalı veya reddedilen operasyonlar sonraki bekleyen işlemleri bloke etmez.
- **Kalıcı Nonce Replay Saklama Politikası (`seenUntil` / Time-Based Retention):**
  - Keyfi liste boyutu sınırı (`state.seen.slice(-2000)`) güvenlik zafiyeti yarattığından kaldırılmıştır.
  - Nonce'lar token'ın `exp` değeri, saat sapması toleransı (`clockSkewMs = 5 dk`) ve varsayılan saklama süresi (`defaultRetentionMs = 24 saat`) dikkate alınarak saklanır (`seenUntil: Record<string, number>`).
  - 2.000'den fazla farklı nonce tüketilse dahi, süresi dolmamış hiçbir nonce replay korumasından çıkarılamaz; ilk nonce tekrar sunulduğunda derhal `REPLAY_DETECTED` ile reddedilir.
- **Salt Süre Eşiğine Dayanmayan Aktif Kilit Güvencesi:**
  - Kilit sahibi 4 saniyeden uzun süre işlem yapsa dahi kilidi asla başka bir süreç tarafından "stale" sayılarak silinemez veya çalınamaz.
  - Kilit serbest kalana kadar diğer yarışan süreçler jitter ve exponential backoff ile `timeoutMs` süresince sıraya girer; kazanan süreç tekildir.
- **Çökme Güvenliği ve Otomatik Kurtarma (Crash Recovery):**
  - Bir süreç işlem ortasında beklenmedik şekilde sonlandırılırsa (çökme, `SIGKILL` veya process termination), işletim sistemi çekirdeği açık dosya tanıtıcısını derhal kapatır ve SQLite kilitlerini anında serbest bırakır.
  - Yetim (orphaned) kilit dosyası riski sıfırlanmıştır; arkadan gelen süreçler kilit dosyasını temizlemeye çalışırken yeni bir sürecin kilidini silme riski taşımadan kilidi güvenle devralır.
- **Kalıcı Durum ve İki Aşamalı Atomik Rezervasyon:**
  - Görülmüş nonce'lar (`seen`, `seenUntil`) ve aktif rezervasyonlar (`reserved`) diske senkronize yazılır. Süreç yeniden başlatılsa bile kullanılmış bir nonce asla yeniden tüketilemez.
  - **Rezervasyon:** `reserveNonce(nonce, ttl)` çağrısı çekirdek kilidi altında işletilir. Eşzamanlı gelen çoklu süreçlerden/isteklerden yalnızca biri rezervasyonu alır; diğer tüm eşzamanlı süreçler anında `REPLAY_DETECTED` ile fail-closed durur.
  - **Tüketim veya İptal:** Kriptografik imza veya bağlam kontrolleri başarısız olursa kilit altında rezervasyon serbest bırakılır (`releaseReservation`); kontroller eksiksiz geçerse `markNonceSeen` ile kalıcı olarak harcanır.
- Süresi dolmuş (`exp`), gelecekte düzenlenmiş (`iat`) veya henüz yürürlüğe girmemiş (`nbf`) token'lar reddedilir.

### 3.6. mTLS Sertifikası Doğrulama Sınırı
- İstemcinin gönderdiği metadatanın güvenilirliği reddedilir; gerçek X.509 sertifika ayrıştırması veya `verifyTlsConnectionFn` doğrulaması zorunludur.

### 3.7. Hassas Veri Maskeleme ve Güvenli Loglama
- Ham JWT belirteçleri, authorization header'ları, özel anahtarlar ve PII (kişisel tanımlayıcı veriler) `TrustedIdentitySanitizer` tarafından maskelenmeden `HistoryManager` veya kalıcı defterlere yazılamaz.
- Loglarda yalnızca kimlik sağlayıcısı, kullanıcı konusu (`sub`), maskelenmiş parmak izi ve bağlam özetleri yer alır.

### 3.8. JWKS SSRF ve Kapsamlı IPv4 / IPv6 Savunması
- **CIDR Kapsamı ve Normalizasyon:**
  - IPv4: Loopback (`127.0.0.0/8`), Özel (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), Link-local (`169.254.0.0/16`), CGNAT (`100.64.0.0/10`), Dokümantasyon (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), Benchmarking (`198.18.0.0/15`), Multicast (`224.0.0.0/4`), Unspecified/Broadcast (`0.0.0.0/8`, `255.255.255.255/32`).
  - IPv6: Unspecified (`::/128`), Loopback (`::1/128`), Unique Local (ULA `fc00::/7`), Link-local (`fe80::/10`), Multicast (`ff00::/8`), Dokümantasyon (`2001:db8::/32`), ORCHIDv2 (`2001:20::/28`), IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible (`::/96`), NAT64/DNS64 (`64:ff9b::/96`), 6to4 (`2002::/16`).
  - IPv4-mapped IPv6 adresleri (`::ffff:127.0.0.1`, `::ffff:169.254.169.254`, `::ffff:10.0.0.1` vb.) ve alternatif gösterimler normalleştirilerek hem IPv6 hem de gömülü IPv4 kurallarıyla denetlenir.
- **DNS Ön Kontrolü ve Uçuş Sırası (In-Flight Socket) Doğrulaması:**
  - Ön kontrol (`validateJwksHostDns`) ve gerçek HTTPS bağlantı anındaki TLS soket çözümlemesi (`ssrfGuardedLookup`) birebir aynı güvenlik politikasını uygular.
  - `lookup` fonksiyonu hem tekil hem de çoklu DNS yanıtlarını (`all: true`) destekler; bir DNS yanıtındaki IP adreslerinden herhangi biri yasaklı aralıktaysa bağlantı kurulmadan istek derhal reddedilir.
  - **DNS Rebinding (TOCTOU) Engeli:** Ön kontrolde genel/geçerli bir IP dönse dahi, TLS soketi açılırken gerçekleşen ikinci çözümlemede dönen IP özel/yasaklı ise bağlantı kurulmadan fail-closed durulur.
  - DNS çözümleme hataları, boş yanıtlar ve hatalı IP biçimleri fail-closed reddedilir.
  - TLS sertifika doğrulaması (`servername`) bozulmaz; HTTP 3xx yönlendirmeleri (`followRedirects: false`) izlenmez.

### 3.9. Fail-Closed Davranış Güvencesi
- Sağlayıcı yapılandırılmamışsa (`UnconfiguredIdentityProviderAdapter`): `BLOCKED_ON_AUTH_CONTEXT`.
- Sağlayıcıya ulaşılamıyorsa (network timeout, DNS hatası, IdP 5xx): `BLOCKED_ON_AUTH_CONTEXT`.
- İmza geçersizse veya issuer/audience uyuşmuyorsa: `BLOCKED_ON_AUTH_CONTEXT`.
- İptal edilmiş kimlik veya bağlam uyuşmazlığı varsa: `BLOCKED_ON_AUTH_CONTEXT`.
- DNS hatası veya SSRF/Rebinding şüphesi varsa: `BLOCKED_ON_AUTH_CONTEXT`.
- Nonce durumu bozuk, okunamayan veya şemaya uymayan durumda ise: `BLOCKED_ON_AUTH_CONTEXT`.

### 3.10. Nonce Durumunun Fail-Closed Kurtarılması, Şema Doğrulaması ve Adli Kanıt Koruma (Forensic Evidence Preservation)
- **Durum Ayrımı ve İlk Oluşturma:**
  - Nonce dosyasının diskte henüz var olmaması (`ENOENT`) açık ve tekil bir ilk oluşturma (bootstrap) durumu olarak kabul edilir; yalnızca bu durumda boş başlangıç durumu (`{ seen: [], seenUntil: {}, reserved: {} }`) üretilir.
  - Dosyanın boş olması (0 bayt), kesilmiş JSON içermesi, sözdizimi hatası (JSON parse error), dosya izin/okuma hataları (`EACCES`, `EPERM`) veya geçersiz şema durumlarında sistem asla boş başlangıç durumuna düşmez (no silent fallback).
  - Şema Doğrulaması: Kök değerin nesne olmaması (literal `null`, sayı, boolean, string) veya `seen` alanının dizi olmaması durumları fail-closed olarak `StorageError` fırlatır. Geriye dönük uyumluluk için eski salt string dizi formatı güvenle korunur.
- **Fail-Closed Onay ve Replay Engeli:**
  - Nonce durumu doğrulanamıyorsa, onay ve replay kontrolleri doğrudan fail-closed olarak durur.
  - `OidcIdentityProviderAdapter`, `MtlsIdentityProviderAdapter` ve `TestDoubleIdentityProviderAdapter` ile `AuthContextValidator` katmanlarında `NonceStore` istisnaları yakalanarak istek `UNVERIFIED` ve `BLOCKED_ON_AUTH_CONTEXT` olarak reddedilir; sırlar ve iç yığın izleri sızdırılmadan istemciye güvenli hata kodu iletilir.
- **Adli Kanıtın Korunması (No Silent Overwrite):**
  - Hata durumunda veya dosya bozulduğunda, mevcut bozuk dosya asla sessizce boş durumla veya yeni verilerle ezilmez/silinmez. `atomicWriteJson` çağrısına geçilmediği için disk üzerindeki bozuk durum adli inceleme (forensic audit) amacıyla olduğu gibi korunur.
- **Süreç Yeniden Başlatma ve Bağımsız Örnek Tutarlılığı:**
  - Süreç yeniden başlatılsa veya farklı `NonceStore` örnekleri başlatılsa dahi bozuk dosya karşısında her zaman deterministik ve tekdüze biçimde fail-closed ret üretilir.
  - Eşzamanlı işletim sistemi süreçleri (child processes) bozuk/okunamayan durum karşısında birbirinden farklı veya güvensiz sonuçlara ulaşamaz; tüm süreçler fail-closed durur.
- **Gelişmiş IPv6 SSRF Sertleştirmesi:**
  - RFC 3879 Site-Local Unicast aralığı (`fec0::/10`) `FORBIDDEN_IPV6_RANGES` listesine eklenmiştir.
  - `parseIpv6` ayrıştırıcısı; üç ardışık iki nokta (`:::`), tekil baştaki/sondaki iki nokta (`:1::`, `::1:`), geçersiz hextet karakterleri/uzunlukları ve gömülü IPv4 adreslerindeki geçersiz/sekizlik (octal) gösterimleri (`::ffff:0127.0.0.1`) fail-closed olarak reddedecek şekilde sertleştirilmiştir.

---

## 4. Kararın Etkileri

1. **OM-09 Durumu:** Rutin mandate görevleri otonom çalışmayı sürdürürken (`ALLOW`), insan onayı alt kapsamı gerçek bir IdP yapılandırması bağlanana kadar meşru ve bilinçli bir güvenlik kilidi olarak `BLOCKED_ON_AUTH_CONTEXT` durumunda kalır. OM-09 genel kabulü verilemez.
2. **P18-04 Kabul Durumu:** Adaptör seviyesinde güvenlik açıkları kapatılmış olsa da, gerçek bir canlı harici IdP kurulana ve doğrulanana kadar P18-04 genel kabulü verilmez; durum **`BLOCKED_ON_EXTERNAL_IDP`** olarak mühürlüdür.
3. **OM-10 Durumu:** Gerçek dış IdP entegrasyonu tamamlanmadan ve canlı ortamda doğrulanmadan OM-10 kesinlikle başlatılamaz. OM-10 kapısı BLOCKED olarak mühürlü kalır.
4. **Geliştirici Güvencesi:** Sahte alanlarla (`isTrustedHumanAuth: true`, `actor: "USER"`) güvenlik kilidinin atlatılması matematiksel ve mimari olarak engellenmiştir.
