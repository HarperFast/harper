window._kmq = window._kmq || [];

const deployKissmetricsBase = () => {
  const scr = document.createElement('script');
  scr.setAttribute('async', 'true');
  scr.type = 'text/javascript';
  scr.src = 'https://i.kissmetrics.io/i.js';
  ((document.getElementsByTagName('head') || [null])[0] || document.getElementsByTagName('script')[0].parentNode).appendChild(scr);
};

const deployKissmetricsAccount = () => {
  const scr = document.createElement('script');
  scr.setAttribute('async', 'true');
  scr.type = 'text/javascript';
  scr.src = 'https://scripts.kissmetrics.io/708f0eb42f1de25a1563ca9ce9953b870d3f450f.2.js';
  ((document.getElementsByTagName('head') || [null])[0] || document.getElementsByTagName('script')[0].parentNode).appendChild(scr);
};

setTimeout(() => {
  if (window.location.hostname === 'studio.harperdb.io') {
    deployKissmetricsBase();
    deployKissmetricsAccount();
  }
}, 1000);
