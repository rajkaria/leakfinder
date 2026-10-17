# Serves the static LeakFinder page on port 8080. No build step.
# CreateOS upload project: `createos deploy --project <id> --dir site` (see DEPLOY.md).
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
EXPOSE 8080
