import uuid as uuid_mod
from sqlalchemy import Column, Integer, String, ForeignKey, DateTime, Boolean, Table, Text, Float
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base

# Association table for many-to-many relationship between playlists and tracks
playlist_tracks = Table(
    'playlist_tracks',
    Base.metadata,
    Column('playlist_id', Integer, ForeignKey('playlists.id'), primary_key=True),
    Column('track_id', Integer, ForeignKey('tracks.id'), primary_key=True),
    Column('position', Integer, default=0),
    Column('added_at', DateTime(timezone=True), server_default=func.now())
)

# Association table for user liked tracks
user_liked_tracks = Table(
    'user_liked_tracks',
    Base.metadata,
    Column('user_id', Integer, ForeignKey('users.id'), primary_key=True),
    Column('track_id', Integer, ForeignKey('tracks.id'), primary_key=True),
    Column('liked_at', DateTime(timezone=True), server_default=func.now())
)

# Association table for user track plays (for recommendations)
user_track_plays = Table(
    'user_track_plays',
    Base.metadata,
    Column('user_id', Integer, ForeignKey('users.id'), primary_key=True),
    Column('track_id', Integer, ForeignKey('tracks.id'), primary_key=True),
    Column('play_count', Integer, default=1),
    Column('last_played', DateTime(timezone=True), server_default=func.now())
)


class LikedArtist(Base):
    __tablename__ = "liked_artists"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    artist_id = Column(String, nullable=False)
    artist_name = Column(String, nullable=False)
    avatar_url = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="liked_artists")


class LikedPlaylist(Base):
    __tablename__ = "liked_playlists"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    playlist_id = Column(Integer, ForeignKey("playlists.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="liked_playlists")
    playlist = relationship("Playlist")

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    full_name = Column(String, nullable=True)
    avatar_url = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    is_email_verified = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    playlists = relationship("Playlist", back_populates="owner", cascade="all, delete-orphan")
    liked_tracks = relationship("Track", secondary=user_liked_tracks, back_populates="liked_by_users")
    track_plays = relationship("Track", secondary=user_track_plays, back_populates="played_by_users")
    liked_artists = relationship("LikedArtist", back_populates="user", cascade="all, delete-orphan")
    liked_playlists = relationship("LikedPlaylist", back_populates="user", cascade="all, delete-orphan")


class Track(Base):
    __tablename__ = "tracks"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False, index=True)
    artist = Column(String, nullable=False, index=True)
    album = Column(String, nullable=True)
    duration = Column(Integer, nullable=False)  # Duration in seconds
    file_path = Column(String, nullable=False)
    cover_url = Column(String, nullable=True)
    genre = Column(String, nullable=True, index=True)
    release_date = Column(DateTime(timezone=True), nullable=True)
    play_count = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    playlists = relationship("Playlist", secondary=playlist_tracks, back_populates="tracks")
    liked_by_users = relationship("User", secondary=user_liked_tracks, back_populates="liked_tracks")
    played_by_users = relationship("User", secondary=user_track_plays, back_populates="track_plays")


class Playlist(Base):
    __tablename__ = "playlists"

    id = Column(Integer, primary_key=True, index=True)
    uuid = Column(String, unique=True, index=True, default=lambda: str(uuid_mod.uuid4()))
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    cover_url = Column(String, nullable=True)
    is_public = Column(Boolean, default=True)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    owner = relationship("User", back_populates="playlists")
    tracks = relationship("Track", secondary=playlist_tracks, back_populates="playlists", order_by="playlist_tracks.c.position")
