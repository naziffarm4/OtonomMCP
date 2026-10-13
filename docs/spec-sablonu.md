# Proje adı (örn. "Saç Atölyesi Web Sitesi")

<!--
SPEC ŞABLONU — nasıl kullanılır:
1. Bu dosyayı proje klasörünüze `proje.md` adıyla kopyalayın.
2. Köşeli parantezli açıklamaları kendi bilgilerinizle değiştirin, gereksiz satırları silin.
3. Antigravity'de "bu spec'i çalıştır" deyin (veya: aidm run --spec proje.md).
Başlıkları silmeyin: parantez içindeki anahtar kelimeler (Gereksinimler, Kabul Kriterleri, Kurallar)
sistemin bölümleri tanıması içindir.
-->

- **Yürütücü:** ide
- **İnceleme:** gerektiğinde
- **Netleştirme:** açık
- **İlerleme notu:** 3

<!--
Yürütücü seçenekleri → ide (varsayılan: işi Antigravity sohbeti yapar) | cli | cli-oturum
İnceleme seçenekleri → her görev | gerektiğinde | hiç  (kod yazmadan önce ayrı okuma/analiz adımı)
Netleştirme seçenekleri → açık | kapalı  (başlamadan önce Director size soru sorsun ve yaklaşım planını onayınıza sunsun mu)
İlerleme notu seçenekleri → sayı (kaç görevde bir kısa not) | kapalı
-->

## Amaç

[Bu proje neden var, ne işe yarayacak? 2-4 cümle.]

## Hedef Kitle

[Kimler kullanacak? Yaş, ihtiyaç, cihaz (çoğunlukla telefon mu?).]

## Sayfalar (Gereksinimler)

<!-- Her sayfa / özellik için bir ### başlığı. Dosya adını `ters tırnak` içinde yazın. -->

### Ana sayfa
`index.html`: [neler olacak? örn. salon adı, kısa slogan, öne çıkan 3 hizmet, randevu butonu]

### [Sayfa 2]
`[dosya.html]`: [içerik]

## Kabul Kriterleri (Olmazsa olmazlar)

<!-- "Bunlar yoksa iş bitmiş sayılmaz" dediğiniz maddeler. -->
- [örn. Telefon numarası her sayfada görünür ve tıklanınca arar]
- [örn. Tüm sayfalarda aynı üst menü var]

## Tasarım Tercihleri (Kurallar)

- Renkler / hava: [örn. sıcak, doğal tonlar; pembe istemiyorum]
- Yazı tipi: [örn. okunaklı, sade]
- Beğendiğiniz örnek siteler: [bağlantılar]
- İstemedikleriniz: [örn. otomatik açılan video, çok animasyon]

## Kapsam Dışı

- [Bu sürümde yapılmayacaklar, örn. online ödeme]

## Örnek (doldurulmuş spec — kopyalarken bu bölümü silin)

```markdown
# Saç Atölyesi Web Sitesi

- **Yürütücü:** ide
- **İnceleme:** gerektiğinde
- **Netleştirme:** açık

## Amaç

Mahalledeki kuaförümüz için randevu talebi toplayan, hizmetleri ve fiyatları gösteren sade bir tanıtım sitesi.

## Hedef Kitle

25-55 yaş, çoğunlukla telefondan bakan, yakın semtlerden müşteriler.

## Sayfalar (Gereksinimler)

### Ana sayfa
`index.html`: salon adı, kısa slogan, öne çıkan 3 hizmet, "Randevu al" butonu.

### Hizmetler
`hizmetler.html`: hizmet listesi ve başlangıç fiyatları.

### İletişim
`iletisim.html`: adres, harita bağlantısı, çalışma saatleri, telefon ve randevu formu (ad, telefon, tarih).

## Kabul Kriterleri (Olmazsa olmazlar)

- Tüm sayfalarda aynı üst menü ve aynı stil dosyası (`style.css`) var.
- Telefon numarası her sayfada görünür ve tıklanınca arar.
- Sayfalar telefonda yatay kaydırma olmadan düzgün görünür.

## Tasarım Tercihleri (Kurallar)

- Sıcak, doğal tonlar (krem, toprak); pembe yok.
- Büyük, okunaklı yazılar; sade düzen.

## Kapsam Dışı

- Online ödeme ve üyelik sistemi.
```
