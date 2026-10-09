# Eğitim pilotu paketi (yol haritası F5)

> Bu belge Türkçedir: SiberSentez'i bir sınıfta ya da kursta deneyecek öğretmen içindir. Amaç, bir okul ya da kursla
> küçük bir pilotla eğitim kullanımına gerçek bir talep olup olmadığını görmektir (gelir kararı ancak bundan sonra).

## Kime

Ortaokul üst sınıfları, lise, halk eğitim ve kodlama kulüpleri; öğrencilerin kod yazmasını değil, **bir fikri yapay
zekâyla çalışan bir şeye dönüştürmeyi** öğrenmesi hedeflenen dersler.

## Hazırlık (öğretmen, dersten önce, ~30 dk)

1. Her bilgisayara SiberSentez kurulur. Sol menüde **Yapay zekâ araçları** (ya da başlangıç kartındaki "Bir yapay zekâ
   aracı edin" adımı) açılır; hiç araç kurulu değilse **Bir yapay zekâ aracını hazırla** sihirbazı kendiliğinden gelir.
2. Araç: ücretsiz başlamak için **GitHub Copilot CLI**. GitHub'ın ücretsiz Copilot planı Copilot CLI'yi küçük bir aylık
   hakla içerir (GitHub'ın plan sayfası, son bakış 9 Ekim 2026). Hak bir ders için yetebilir ama sınıf boyunca tek
   hesapla paylaşılırsa çabuk biter: dersten önce bir deneme işi çalıştırıp kalan hakkı kontrol edin. Hesap
   öğretmenin hesabıysa öğrencilerle paylaşılmaz, her bilgisayara öğretmen girer. Ücretli bir plan (Claude, ChatGPT
   Plus, Copilot Pro) daha uzun dersler için daha rahattır.
   *Not:* Daha önce burada önerilen Gemini CLI, 18 Haziran 2026'dan beri yalnız ücretli API anahtarıyla çalışıyor;
   Google ücretsiz kullanımı yeni aracı Antigravity CLI'ye taşıdı. Ücretsiz haklar sık değişir: her dönem başında
   aracın kendi sayfasından yeniden bakın.
3. Ayarlar › Eylemler: ders boyunca **Açık** (yapay zekâ proje klasörüne yazabilsin). Her iş başlamadan önce projenin
   bir kopyası saklanır ve "Önceki hâle dön" onu geri getirir (çok büyük bir projede, binlerce dosyada, kopya
   alınamayabilir; ders projeleri bu sınırın çok altındadır).
4. Projeler `Belgeler › SiberSentez` altında açılır; ders sonunda öğrenci kendi klasörünü bir USB belleğe alabilir.

## Ders 1 (40 dk): "Kulübümüzün sayfası"

| Süre | Etkinlik |
|---|---|
| 5 dk | Gösteri: öğretmen bir fikir yazar, planın nasıl onaylandığını gösterir. |
| 10 dk | Öğrenciler **Yeni proje**'ye basar, ad ve fikri yazar: "Bilim kulübümüzün etkinlik takvimi olan bir sayfası". |
| 15 dk | Yapay zekâ planı yazar; öğrenci okur, onaylar, sonucu **Aç / çalıştır** ile tarayıcıda görür. |
| 10 dk | Sınıf tartışması: "Yapay zekâ neyi doğru, neyi yanlış anladı? Nasıl daha iyi anlatırdın?" |

## Ders 2 (40 dk): "Değiştir, boz, geri al"

| Süre | Etkinlik |
|---|---|
| 10 dk | Aynı projeye yeni iş: "Renkleri okul renklerimize çevir, bir iletişim formu ekle." |
| 10 dk | Bilerek bozma: "Sayfanın yarısını sil" işi verilir; sonuç incelenir. |
| 10 dk | **Önceki hâle dön**: öğrenci geri dönmeden önce neyin değişeceğini okur ve geri döner. |
| 10 dk | Değerlendirme: her öğrenci bir cümleyle "yapay zekâya iyi iş anlatmanın kuralı"nı yazar. |

## Güvenlik ve sınırlar

- Yapay zekâ aracı proje klasöründe başlatılır ve başka bir yere dokunmadan önce izin sorar; öğrencilere bu sorulara
  okumadan "evet" dememeleri söylenir. Eylemler **Kapalı**'yken SiberSentez proje klasörlerine hiçbir şey yazmaz.
- Öğrencilerin kişisel bilgi (ad soyad, adres, telefon) yazmaması hatırlatılır: yazılanlar seçilen yapay zekâ
  sağlayıcısına gider.
- Ücretsiz API anahtarının günlük sınırı vardır; sınır dolarsa terminaldeki hata kutusu bunu sade bir dille söyler.
- Uygulama yalnız Windows 10/11'de çalışır.

## Pilotun ölçüleri (öğretmen doldurur)

| Soru | Cevap |
|---|---|
| Kaç öğrenci ders 1'de kendi sayfasını açabildi? | __ / __ |
| Kaç öğrenci ders 2'de geri dönebildi ve neyin değişeceğini doğru söyledi? | __ / __ |
| En çok nerede yardım gerekti? | |
| Öğretmen olarak tekrar kullanır mısın? (1–7) | |
| Okulun/kursun bunu bir paket olarak istemesi için ne gerekirdi? | |

Ölçüler `docs/evidence-<tarih>.md` dosyasına yazılır; gelir kararı (ücretli eğitim paketi olup olmayacağı) bunlara
göre verilir.

## Okul bilgisayarı için tek sayfa (öğretmen, dersten önce)

Her bilgisayarda bir kez, sırayla:

1. **Windows 10 ya da 11, 64 bit.** Yönetici izni gerekmez; kurulum yalnız o kullanıcıya yapılır.
2. **SiberSentez'i kur:** sibersentez.com'daki indirme düğmesi. Windows "Bilgisayarınız korundu" derse: "Ek bilgi" →
   "Yine de çalıştır" (sitedeki SSS "Windows uyarırsa" adımları; isterseniz SHA-256'yı doğrulayın).
3. **Araç:** SiberSentez açılınca **Yapay zekâ araçları** → sihirbaz. Ücretsiz başlangıç için **GitHub Copilot CLI**
   (bir GitHub hesabı; ücretsiz planın küçük aylık hakkı vardır). Git ve Node.js gerekirse sihirbaz söyler; komutu
   sihirbaz terminale yazar, Enter'a öğretmen basar.
4. **Giriş:** sihirbazın giriş adımı. Hesap öğretmeninse şifre öğrenciye gösterilmez.
5. **Eylemler:** üstteki **Eylemler** göstergesi → **Açık** (ders boyunca).
6. **Deneme işi:** Bina'da yeni bir proje aç, iş kutusuna "Başlığı ve kısa bir yazısı olan tek sayfalık bir site yap"
   yaz, Başlat. Sonuç gelince **Aç** ile tarayıcıda bak, sonra **İşten önceki hâle dön** ile geri al. Bu tur, hesabın
   ve hakların çalıştığını gösterir.
7. **Ders sonunda:** projeler `Belgeler › SiberSentez` altında; öğrenci kendi klasörünü USB belleğe alabilir.
   Bilgisayar ortaksa her öğrenciye ayrı Windows hesabı önerilir: SiberSentez'in her açılışta ürettiği anahtar,
   başka bir hesabın bu hesabın oturumlarını okumasını engeller.

Sorun olursa: Ayarlar › Yardım › **Tanılama bilgisi · Kopyala** ve **Kayıt dosyaları · Klasörü aç**; ikisi de
yalnız bu bilgisayarda kalır, istenirse bir soruna eklenir.
