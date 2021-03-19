module.exports = {
  siteTitle: 'Cyrus Behroozi | Software Engineer',
  siteDescription:
    'Cyrus Behroozi is a software engineer based in Los Angeles who specializes in high performance computer vision.',
  siteKeywords:
    'Cyrus Behroozi, Cyrus, Behroozi, cyrus.behr, cyrusbehr, software engineer, computer vision, machine learning, C++',
  siteUrl: 'https://cyrusbehr.com', //TODO Cyrus
  siteLanguage: 'en_US',
  name: 'Cyrus Behroozi',
  location: 'Los Angeles, CA',
  email: '',
  github: 'https://github.com/cyrusbehr',
  twitterHandle: '',
  socialMedia: [
    {
      name: 'Github',
      url: 'https://github.com/cyrusbehr',
    },
    {
      name: 'Linkedin',
      url: 'https://www.linkedin.com/in/cyrus-behroozi/',
    },
  ],

  navLinks: [
    {
      name: 'About',
      url: '/#about',
    },
    {
      name: 'Experience',
      url: '/#jobs',
    },
    {
      name: 'Work',
      url: '/#projects',
    },
    {
      name: 'Articles',
      url: '/#blogs',
    },
    {
      name: 'Contact',
      url: '/#contact',
    },
  ],

  navHeight: 100,
  greenColor: '#64ffda',
  navyColor: '#0a192f',
  darkNavyColor: '#020c1b',

  srConfig: (delay = 200) => ({
    origin: 'bottom',
    distance: '20px',
    duration: 500,
    delay,
    rotate: { x: 0, y: 0, z: 0 },
    opacity: 0,
    scale: 1,
    easing: 'cubic-bezier(0.645, 0.045, 0.355, 1)',
    mobile: true,
    reset: false,
    useDelay: 'always',
    viewFactor: 0.25,
    viewOffset: { top: 0, right: 0, bottom: 0, left: 0 },
  }),
};
