function doGet() {
  return HtmlService.createHtmlOutputFromFile('index.html')
      .setTitle('소수의 용사') // 브라우저 탭에 표시될 이름
      .addMetaTag('viewport', 'width=device-width, initial-scale=1'); // 모바일 화면 맞춤
}
