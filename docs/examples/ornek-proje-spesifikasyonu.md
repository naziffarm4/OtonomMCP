# Mini Hesap Makinesi

Node.js ile yazılmış, harici bağımlılığı olmayan küçük bir hesap makinesi kütüphanesi ve testleri.

## Hedef Kullanıcılar
- Kütüphaneyi kendi projesine ekleyen geliştiriciler

## Teknoloji
- Node.js 22 (ESM)
- Testler için yerleşik `node --test`

## Gereksinimler

### Toplama
`src/add.js` dosyasında `add(a, b)` fonksiyonu dışa aktarılır.
- `add(2, 3)` sonucu `5` olur
- Sayı olmayan girdide `TypeError` fırlatılır

### Çarpma
`src/multiply.js` dosyasında `multiply(a, b)` fonksiyonu dışa aktarılır.
- `multiply(4, 5)` sonucu `20` olur

### Testler
`tests/calc.test.js` dosyasında tüm fonksiyonlar için birim testleri yazılır.
- `node --test tests/` başarıyla tamamlanır

## Kabul Kriterleri
- Tüm birim testleri geçer

## Kısıtlar
- Harici npm bağımlılığı eklenmez
- Yalnızca proje kök dizini içinde çalışılır

## Kapsam Dışı
- Grafik arayüz
- npm'e yayınlama

## Dizinler
- `src/`
- `tests/`

## Komutlar
```bash
node --test tests/
```
