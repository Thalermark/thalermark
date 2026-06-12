// The `disposable-email-domains` package ships an index.json array with no
// types. It's just a list of domain strings.
declare module 'disposable-email-domains' {
  const domains: string[];
  export default domains;
}
