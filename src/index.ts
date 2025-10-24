// server/src/index.ts
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import SpotifyWebApi from 'spotify-web-api-node';
import 'dotenv/config';

// @ts-ignore
import { TrackObjectFull } from 'spotify-web-api-node-ts/src/types/SpotifyObjects';

const app = express();
app.use(express.json());

const corsOptions = {
  origin: 'https://genrefinder.xyz',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


// ▼▼▼ 이 부분이 수정되었습니다 ▼▼▼
const isProduction = process.env.NODE_ENV === 'production';
const redirectUri = isProduction
  ? `${process.env.BACKEND_URL}/api/callback` // 실제 서버 환경일 때
  : 'http://127.0.0.1:8080/api/callback';   // 개발 환경일 때

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: redirectUri // 동적으로 설정된 redirectUri 사용
});
// ▲▲▲ 이 부분이 수정되었습니다 ▲▲▲


app.get('/api/login', (req, res) => {
  const scopes = ['playlist-modify-public', 'playlist-modify-private'];
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, 'state-key', true);
  res.redirect(authorizeURL);
});

app.get('/api/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const data = await spotifyApi.authorizationCodeGrant(code as string);
    const { access_token, refresh_token } = data.body;
    
    // 이제 프론트엔드 주소로 안전하게 리디렉션합니다.
    res.redirect(`https://genrefinder.xyz?access_token=${access_token}&refresh_token=${refresh_token}`);

  } catch (err) {
    console.error('Callback Error:', err);
    res.status(400).send('Error getting tokens');
  }
});

// ... (이하 모든 코드는 이전과 동일합니다) ...

app.post('/api/recommend-genres', async (req, res) => {
  const { query, accessToken } = req.body;
  if (!query) return res.status(400).json({ error: 'Query is required' });
  if (!accessToken) return res.status(401).json({ error: 'Access Token is required'});

  const userSpotifyApi = new SpotifyWebApi({ accessToken });

  try {
    let artist: any = null; // 아티스트 정보를 담을 변수

    // 1. 먼저 곡(Track)으로 검색
    const trackSearch = await userSpotifyApi.searchTracks(query, { limit: 1 });
    if (trackSearch.body.tracks && trackSearch.body.tracks.items.length > 0) {
      // 곡을 찾았다면, 그 곡의 첫 번째 아티스트 정보를 사용
      const trackArtistId = trackSearch.body.tracks.items[0].artists[0].id;
      const artistResponse = await userSpotifyApi.getArtist(trackArtistId);
      artist = artistResponse.body;
    } else {
      const artistSearch = await userSpotifyApi.searchArtists(query, { limit: 1 });
      if (!artistSearch.body.artists || artistSearch.body.artists.items.length === 0) {
        return res.status(404).json({ error: 'Artist not found' });
      }
      artist = artistSearch.body.artists.items[0];
    }
    if (!artist) {
      return res.status(404).json({ error: 'Artist or Track not found' });
    }
    
    const prompt = `
      You are a world-class music curator. A user is searching for an artist named "${artist.name}".
      Based on this artist's style, recommend 3 unique and interesting music genres.
      For each genre, provide a short, engaging description and 3 other representative artists.
      Do not recommend the genre "${artist.genres.join(', ')}" or the artist "${artist.name}".
      Provide the response strictly in JSON format like this, including spotifyTrackIds for each recommended artist's top track:
      {
        "genres": [
          {
            "name": "Genre Name", 
            "description": "Genre description.", 
            "artists": [
              {"artistName": "Artist A", "spotifyTrackId": "TRACK_ID_1"},
              {"artistName": "Artist B", "spotifyTrackId": "TRACK_ID_2"},
              {"artistName": "Artist C", "spotifyTrackId": "TRACK_ID_3"}
            ]
          },
          ...
        ]
      }
    `;
    
    const aiGenres = {
        "genres": [
            { "name": "Synthwave", "description": "A genre of electronic music influenced by 1980s film soundtracks and video games.", "artists": [
                {"artistName": "Carpenter Brut", "spotifyTrackId": "4l6Jhd2zCoi1vaY1HnN2oA"},
                {"artistName": "Kavinsky", "spotifyTrackId": "2c3fn9MJZmMv0nCqS2eW9C"},
                {"artistName": "Perturbator", "spotifyTrackId": "063oN03t0kG3Jp8UNa3o8M"}
            ]},
            { "name": "Dream Pop", "description": "Characterized by its ethereal soundscapes and pop melodies.", "artists": [
                {"artistName": "Beach House", "spotifyTrackId": "322sQNpYo2t1732s7dF4l8"},
                {"artistName": "Cocteau Twins", "spotifyTrackId": "33Zb2B0Q30gV5lH6I9slsM"},
                {"artistName": "Cigarettes After Sex", "spotifyTrackId": "73T16nK9b3ZU32hXM9aEa2"}
            ]}
        ]
    };

    const responseData = {
      searchedArtist: {
        name: artist.name,
        imageUrl: artist.images[0]?.url,
      },
      aiRecommendations: aiGenres.genres,
    };

    res.json(responseData);

  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

app.post('/api/save-playlist', async (req, res) => {
    const { accessToken, trackIds, artistName } = req.body;
    if (!accessToken || !trackIds || !artistName) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    const userSpotifyApi = new SpotifyWebApi({ accessToken });

    try {
        const playlistName = `${artistName} inspired by Genre Finder`;
        const playlist = await userSpotifyApi.createPlaylist(playlistName, {
            public: false,
            description: `AI recommended tracks based on ${artistName}. Created by Genre Finder.`
        });
        const playlistId = playlist.body.id;

        const spotifyTrackUris = trackIds.map((id: string) => `spotify:track:${id}`);
        await userSpotifyApi.addTracksToPlaylist(playlistId, spotifyTrackUris);

        res.status(200).json({ message: 'Playlist created successfully!', playlistUrl: playlist.body.external_urls.spotify });

    } catch (err) {
        console.error('Failed to create playlist', err);
        res.status(500).json({ error: 'Failed to create playlist.' });
    }
});

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});