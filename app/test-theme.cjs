const t = require('./theme');

const css = t.buildThemeCss({
  scheme: 'dark', variant: 'glass', radius: 22, blur: 24,
  density: 'normal', cards: 'm', cols: 'auto', accentAuto: false,
  accent: '#ffd23f', heading: '#ffffff', txt: null, dimc: null,
  eq: { on: true },
});
console.log('css lines:', css.split('\n').length);
console.log('has accent:', css.includes('#ffd23f'));
console.log('has heading var:', css.includes('--ym-heading: #ffffff'));

const js = t.buildBlocksScript({ a: { selector: 'footer', mode: 'hide' }, b: {}, c: { selector: 'x' } });
console.log('script has footer:', js.includes('footer'));
console.log('script skips empty:', js.includes('"b"') === false);

const lightCss = t.buildThemeCss({ scheme: 'light', variant: 'paper', radius: 26, blur: 8, density: 'roomy', cards: 'l', cols: 4 });
console.log('light bg:', lightCss.includes('#f3efe7'), 'cols 4:', lightCss.includes('--ym-cols: 4'));
