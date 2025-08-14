# Use the official Node.js 20 image as the base
FROM node:20

# Set the working directory inside the container
WORKDIR /app

# Copy the artifact (Bun build output) from the build process into the container
COPY ./release/ .

# Command to run the built app using Node.js when the container starts
CMD ["node", "index.js"]
